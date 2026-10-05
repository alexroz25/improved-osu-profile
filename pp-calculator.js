// The pp a play is worth, for each ruleset: any play for osu!, catch and mania
// (used by the popup's calculator), and an SS (100% accuracy, full combo) for
// taiko too (used for max pp on profiles).
//
// Ported from osu!'s performance calculators (osu.Game.Rulesets.*/Difficulty/
// *PerformanceCalculator.cs, as of the 2026 Q2 SR & PP release). The
// difficulty attributes come from the osu! API, so only these formulas need
// updating when osu! changes how pp is awarded; star rating changes arrive on
// their own. The API leaves out a few attributes, so some terms are estimated
// (see `osu` below); none of them affect an SS.
//
// To check changes: a ranked play's pp should match what this calculates from
// its hit counts, and a ranked SS play's pp is its max pp. Stable mania SS
// plays are the exception to the latter: their 300s count as 100% accuracy,
// but pp rewards MAX judgements more.

const ppCalculator = (() => {
  // --- Shared helpers (osu.Game/Rulesets/Difficulty/Utils/DiffUtils.cs) ---

  const clamp = (x, min, max) => Math.min(Math.max(x, min), max);
  const norm = (p, ...values) => values.reduce((sum, x) => sum + x ** p, 0) ** (1 / p);
  const reverseLerp = (x, start, end) => clamp((x - start) / (end - start), 0, 1);
  const logistic = (x, midpointOffset, multiplier, maxValue = 1) => maxValue / (1 + Math.exp(multiplier * (midpointOffset - x)));
  const smoothstep = (x, start, end) => {
    x = clamp((x - start) / (end - start), 0, 1);
    return x * x * (3 - 2 * x);
  };

  // osu! uses these approximations rather than exact functions; matching them
  // keeps results identical.
  const erf = (x) => {
    if (x === 0) return 0;
    const t = 1 / (1 + 0.3275911 * Math.abs(x));
    const tau = t * (0.254829592 + t * (-0.284496736 + t * (1.421413741 + t * (-1.453152027 + t * 1.061405429))));
    const result = 1 - tau * Math.exp(-x * x);
    return x >= 0 ? result : -result;
  };

  const erfInv = (x) => {
    if (x <= -1) return -Infinity;
    if (x >= 1) return Infinity;
    if (x === 0) return 0;
    const a = 0.147;
    const sign = Math.sign(x);
    x = Math.abs(x);
    const ln = Math.log(1 - x * x);
    const t1 = 2 / (Math.PI * a) + ln / 2;
    const t2 = ln / a;
    const base = Math.sqrt(t1 * t1 - t2) - t1;
    const correction = x >= 0.85 ? ((x - 0.85) / 0.293) ** 8 : 0;
    return sign * (Math.sqrt(base) + correction);
  };

  // 99% one-tailed critical value, used to estimate deviation from hit counts.
  const Z = 2.32634787404;

  // IBeatmapDifficultyInfo.DifficultyRange: maps a 0–10 difficulty setting
  // onto a value that is `min` at 0, `mid` at 5 and `max` at 10.
  const difficultyRange = (difficulty, min, mid, max) => {
    if (difficulty > 5) return mid + ((max - mid) * (difficulty - 5)) / 5;
    if (difficulty < 5) return mid + ((mid - min) * (difficulty - 5)) / 5;
    return mid;
  };

  const inverseDifficultyRange = (value, diff0, diff5, diff10) =>
    Math.sign(value - diff5) === Math.sign(diff10 - diff5)
      ? ((value - diff5) / (diff10 - diff5)) * 5 + 5
      : ((value - diff5) / (diff5 - diff0)) * 5 + 5;

  // --- Mods ---

  const hasMod = (mods, acronym) => mods.some((m) => m.acronym === acronym);
  const modSetting = (mods, acronym, setting) => mods.find((m) => m.acronym === acronym)?.settings?.[setting];

  // ModUtils.CalculateRateWithMods. Wind up/down and adaptive speed count at
  // their starting rate, as osu! does.
  const RATE_MODS = { DT: ['speed_change', 1.5], NC: ['speed_change', 1.5], HT: ['speed_change', 0.75], DC: ['speed_change', 0.75] };
  const clockRate = (mods) =>
    mods.reduce((rate, mod) => {
      if (RATE_MODS[mod.acronym]) {
        const [setting, fallback] = RATE_MODS[mod.acronym];
        return rate * (mod.settings?.[setting] ?? fallback);
      }
      if (mod.acronym === 'WU' || mod.acronym === 'WD') return rate * Math.round((mod.settings?.initial_rate ?? 1) * 100) / 100;
      if (mod.acronym === 'AS') return rate * (mod.settings?.initial_rate ?? 1);
      return rate;
    }, 1);

  // Beatmap settings after mods (IApplicableToDifficulty). osu! stores these
  // as 32-bit floats, so the arithmetic is rounded the same way; it decides
  // which side of a whole millisecond some hit windows fall on.
  const f = Math.fround;
  const adjustedDifficulty = (beatmap, mods, rulesetId) => {
    let { cs, ar, od, hp } = { cs: f(beatmap.cs), ar: f(beatmap.ar), od: f(beatmap.accuracy), hp: f(beatmap.drain) };
    for (const mod of mods) {
      if (mod.acronym === 'HR') {
        hp = Math.min(f(hp * f(1.4)), 10);
        // Mania's hard rock leaves the beatmap settings alone.
        if (rulesetId !== 3) od = Math.min(f(od * f(1.4)), 10);
        if (rulesetId === 0 || rulesetId === 2) {
          cs = Math.min(f(cs * f(1.3)), 10);
          ar = Math.min(f(ar * f(1.4)), 10);
        }
      } else if (mod.acronym === 'EZ') {
        cs = f(cs * f(0.5));
        ar = f(ar * f(0.5));
        hp = f(hp * f(0.5));
        // Mania's easy widens hit windows its own way instead.
        if (rulesetId !== 3) od = f(od * f(0.5));
      } else if (mod.acronym === 'DA') {
        const s = mod.settings ?? {};
        if (s.drain_rate != null) hp = f(s.drain_rate);
        if (s.overall_difficulty != null) od = f(s.overall_difficulty);
        if (s.circle_size != null) cs = f(s.circle_size);
        if (s.approach_rate != null) ar = f(s.approach_rate);
      }
    }
    return { cs, ar, od, hp };
  };

  // Hit window lengths in ms, as osu!'s HitWindows.SetDifficulty rounds them.
  const hitWindow = (od, min, mid, max) => Math.floor(difficultyRange(od, min, mid, max)) - 0.5;

  // --- osu! (OsuPerformanceCalculator.cs) ---

  const PREEMPT_MAX = 1800;
  const PREEMPT_MID = 1200;
  const PREEMPT_MIN = 450;

  // OsuDifficultyCalculator.SumCognitionDifficulty: reading and flashlight
  // combined, with flashlight counting for less when reading is harder.
  const sumCognition = (reading, flashlight) => {
    if (reading <= 0) return flashlight;
    if (flashlight <= 0) return reading;
    return norm(1.1, reading, flashlight * clamp(flashlight / reading, 0.25, 1));
  };

  // Star rating is cbrt(1.12 × norm(aim, speed, cognition)), so the API's
  // star rating, aim and speed give the cognition value it leaves out.
  const cognitionFromStarRating = (attrs) => {
    const basePerformance = attrs.star_rating ** 3 / 1.12;
    const rest = basePerformance ** 1.1 - (4 * attrs.aim_difficulty ** 3) ** 1.1 - (4 * attrs.speed_difficulty ** 3) ** 1.1;
    return Math.max(0, rest) ** (1 / 1.1);
  };

  // The API leaves out reading_difficulty and flashlight_difficulty. Without
  // FL, cognition is all reading. With FL, the same beatmap's attributes
  // without FL (aim, speed and reading don't change with it) give reading,
  // and flashlight is whatever makes up the rest of cognition. Returns
  // `attrs` with both filled in, for plays that aren't SS; at an SS their sum
  // is all that matters, and `osu` works that out by itself.
  const withCognitionSplit = (attrs, attrsWithoutFlashlight) => {
    if (typeof attrs.reading_difficulty === 'number') return attrs;
    const reading = cognitionFromStarRating(attrsWithoutFlashlight ?? attrs);
    const cognition = attrsWithoutFlashlight ? cognitionFromStarRating(attrs) : reading;

    // Undo sumCognition: weighted is flashlight × clamp(flashlight / reading,
    // 0.25, 1), which grows with flashlight.
    let flashlight = 0;
    if (reading <= 0) {
      flashlight = cognition;
    } else if (cognition > reading) {
      const weighted = (cognition ** 1.1 - reading ** 1.1) ** (1 / 1.1);
      if (weighted <= 0.0625 * reading) flashlight = weighted / 0.25;
      else if (weighted < reading) flashlight = Math.sqrt(weighted * reading);
      else flashlight = weighted;
    }

    return {
      ...attrs,
      reading_difficulty: Math.cbrt(reading / 4),
      flashlight_difficulty: Math.sqrt(flashlight / 25),
    };
  };

  // Estimates for attributes the API leaves out, which only matter for plays
  // with misses (or, with CL, combo breaks).
  const osuEstimates = (attrs, beatmap) => ({
    // How many notes are hard to read, which sets how much misses cost
    // reading. Fitted to the counts implied by ranked lazer plays with misses
    // (October 2026): longer beatmaps and harder reading have more.
    readingDifficultNoteCount:
      attrs.reading_difficult_note_count ??
      1.9 * (beatmap.count_circles + beatmap.count_sliders + beatmap.count_spinners) ** 0.42 * attrs.reading_difficulty ** 1.85,
    // How many of the hardest sections are sliders rather than circles,
    // used to guess how many CL plays' combo breaks were slider breaks.
    // Assumed to follow the beatmap's mix of sliders and circles.
    aimTopWeightedSliderFactor:
      attrs.aim_top_weighted_slider_factor ?? beatmap.count_sliders / Math.max(1, beatmap.count_circles),
    speedTopWeightedSliderFactor:
      attrs.speed_top_weighted_slider_factor ?? beatmap.count_sliders / Math.max(1, beatmap.count_circles),
  });

  const missPenalty = (missCount, difficultStrainCount) => 0.93 / (missCount / (4 * Math.log(Math.max(1, difficultStrainCount))) + 1);

  const osu = ({ attributes: attrs, beatmap, mods, score }) => {
    const sliders = beatmap.count_sliders;
    const spinners = beatmap.count_spinners;
    const objectsWithAccuracyBase = beatmap.count_circles;
    const maxCombo = attrs.max_combo;
    const estimates = osuEstimates(attrs, beatmap);

    const stats = score.statistics;
    const countGreat = stats.great ?? 0;
    const countOk = stats.ok ?? 0;
    const countMeh = stats.meh ?? 0;
    const countMiss = stats.miss ?? 0;
    // Only meaningful without CL, where slider ends and ticks are judged.
    const countSliderEndsDropped = sliders - (stats.slider_tail_hit ?? 0);
    const countSliderTickMiss = stats.large_tick_miss ?? 0;
    const totalHits = countGreat + countOk + countMeh + countMiss;
    const totalSuccessfulHits = countGreat + countOk + countMeh;
    const totalImperfectHits = countOk + countMeh + countMiss;
    const accuracy = clamp(score.accuracy, 0, 1);
    const scoreMaxCombo = clamp(score.maxCombo, 0, maxCombo);

    const rate = clockRate(mods);
    const difficulty = adjustedDifficulty(beatmap, mods, 0);
    const greatHitWindow = hitWindow(difficulty.od, 80, 50, 20) / rate;
    const okHitWindow = hitWindow(difficulty.od, 140, 100, 60) / rate;
    const mehHitWindow = hitWindow(difficulty.od, 200, 150, 100) / rate;
    const overallDifficulty = (79.5 - greatHitWindow) / 6;
    const preempt = difficultyRange(difficulty.ar, PREEMPT_MAX, PREEMPT_MID, PREEMPT_MIN) / rate;
    const approachRate = inverseDifficultyRange(preempt, PREEMPT_MAX, PREEMPT_MID, PREEMPT_MIN);

    const relax = hasMod(mods, 'RX');
    const blinds = hasMod(mods, 'BL');
    const traceable = hasMod(mods, 'TC');
    const classicSliderAccuracy = hasMod(mods, 'CL') && modSetting(mods, 'CL', 'no_slider_head_accuracy') !== false;
    const scoreV2 = hasMod(mods, 'SV2');

    // Combo breaks, estimated from combo. (Ranked stable plays use their
    // score instead, which needs attributes the API leaves out.)
    let comboBasedMissCount = countMiss;
    if (sliders > 0) {
      if (classicSliderAccuracy) {
        // Harder sliders make dropped slider ends (which don't break combo
        // in stable) likelier than slider breaks.
        const likelyMissedSliderEndPortion = 0.04 + 0.06 * Math.min(estimates.aimTopWeightedSliderFactor, 1) ** 2;
        const fullComboThreshold = maxCombo - Math.min(4 + likelyMissedSliderEndPortion * sliders, sliders);
        if (scoreMaxCombo < fullComboThreshold) comboBasedMissCount = fullComboThreshold / Math.max(1, scoreMaxCombo);
        comboBasedMissCount = Math.min(comboBasedMissCount, totalImperfectHits);
        // A slider break loses at least the slider's tick and end.
        const maxPossibleSliderBreaks = Math.min(sliders, Math.trunc((maxCombo - scoreMaxCombo) / 2));
        if (comboBasedMissCount - countMiss > maxPossibleSliderBreaks) comboBasedMissCount = countMiss + maxPossibleSliderBreaks;
      } else {
        const fullComboThreshold = maxCombo - countSliderEndsDropped;
        if (scoreMaxCombo < fullComboThreshold) comboBasedMissCount = fullComboThreshold / Math.max(1, scoreMaxCombo);
        comboBasedMissCount = Math.min(comboBasedMissCount, countSliderTickMiss + countMiss);
      }
    }
    let effectiveMissCount = Math.max(0, Math.min(totalHits, Math.max(countMiss, comboBasedMissCount)));

    // With CL, some oks and mehs are likely slider breaks too.
    const estimatedSliderBreaks = (topWeightedSliderFactor) => {
      const nonMissMistakes = countOk + countMeh;
      if (!classicSliderAccuracy || nonMissMistakes === 0 || effectiveMissCount <= 0) return 0;
      const missedComboPercent = 1 - scoreMaxCombo / maxCombo;
      let sliderBreaks = Math.min(nonMissMistakes, effectiveMissCount * topWeightedSliderFactor);
      const nonMissMistakeAdjustment = (nonMissMistakes - sliderBreaks + 4.5) / (nonMissMistakes + 4);
      sliderBreaks *= smoothstep(effectiveMissCount, 1, 2);
      return sliderBreaks * nonMissMistakeAdjustment * logistic(missedComboPercent, 0.33, 15);
    };
    const aimEstimatedSliderBreaks = estimatedSliderBreaks(estimates.aimTopWeightedSliderFactor);
    const speedEstimatedSliderBreaks = estimatedSliderBreaks(estimates.speedTopWeightedSliderFactor);

    let multiplier = 1.12;
    if (hasMod(mods, 'NF')) multiplier *= Math.max(0.9, 1 - 0.02 * effectiveMissCount);
    if (hasMod(mods, 'SO') && totalHits > 0) multiplier *= 1 - (spinners / totalHits) ** 0.85;
    if (relax) {
      // Relax doesn't stop players from mistiming, so oks and mehs count as
      // partial misses, more so at high OD.
      const okMultiplier = 0.75 * Math.max(0, overallDifficulty > 0 ? 1 - overallDifficulty / 13.33 : 1);
      const mehMultiplier = Math.max(0, overallDifficulty > 0 ? 1 - (overallDifficulty / 13.33) ** 5 : 1);
      effectiveMissCount = Math.min(effectiveMissCount + countOk * okMultiplier + countMeh * mehMultiplier, totalHits);
    }

    // Tap deviation, assuming the worst case: every mistake was on a speed
    // note, and all speed notes are circles. Greats and oks are taken to be
    // normally distributed and mehs uniformly.
    const speedDeviation = (() => {
      if (totalSuccessfulHits === 0) return null;
      const speedNotes = attrs.speed_note_count + (totalHits - attrs.speed_note_count) * 0.1;
      const relevantMiss = Math.min(countMiss, speedNotes);
      const relevantMeh = Math.min(countMeh, speedNotes - relevantMiss);
      const relevantOk = Math.min(countOk, speedNotes - relevantMiss - relevantMeh);
      const relevantGreat = Math.max(0, speedNotes - relevantMiss - relevantMeh - relevantOk);
      if (relevantGreat + relevantOk + relevantMeh <= 0) return null;

      // 99% confidence lower bound on the share of greats (Wilson interval).
      const n = Math.max(1, relevantGreat + relevantOk);
      const p = relevantGreat / n;
      const pLowerBound = Math.min(p, (n * p + (Z * Z) / 2) / (n + Z * Z) - (Z / (n + Z * Z)) * Math.sqrt(n * p * (1 - p) + (Z * Z) / 4));

      let deviation = okHitWindow / Math.sqrt(3);
      if (pLowerBound > 0.01) {
        deviation = greatHitWindow / (Math.SQRT2 * erfInv(pLowerBound));
        // Leave out the tails beyond the ok window.
        const okTail =
          (Math.sqrt(2 / Math.PI) * okHitWindow * Math.exp(-0.5 * (okHitWindow / deviation) ** 2)) /
          (deviation * erf(okHitWindow / (Math.SQRT2 * deviation)));
        deviation *= Math.sqrt(1 - okTail);
      }

      const mehVariance = (mehHitWindow * mehHitWindow + okHitWindow * mehHitWindow + okHitWindow * okHitWindow) / 3;
      return Math.sqrt(((relevantGreat + relevantOk) * deviation ** 2 + relevantMeh * mehVariance) / (relevantGreat + relevantOk + relevantMeh));
    })();

    // Aim.
    let aim = 0;
    if (!hasMod(mods, 'AP')) {
      let aimDifficulty = attrs.aim_difficulty;
      const difficultSliders = attrs.aim_difficult_slider_count ?? 0;
      if (sliders > 0 && difficultSliders > 0) {
        // Sliders that weren't followed properly don't count for their aim.
        // With CL that's every combo break that could have been one;
        // otherwise dropped slider ends and missed ticks.
        const improperlyFollowed = classicSliderAccuracy
          ? clamp(Math.min(totalImperfectHits, maxCombo - scoreMaxCombo), 0, difficultSliders)
          : clamp(countSliderEndsDropped + countSliderTickMiss, 0, difficultSliders);
        aimDifficulty *= (1 - attrs.slider_factor) * (1 - improperlyFollowed / difficultSliders) ** 3 + attrs.slider_factor;
      }

      aim = 4 * aimDifficulty ** 3;
      aim *= 0.95 + 0.35 * Math.min(1, totalHits / 2000) + (totalHits > 2000 ? Math.log10(totalHits / 2000) * 0.5 : 0);
      if (effectiveMissCount > 0) {
        const missCount = Math.min(effectiveMissCount + aimEstimatedSliderBreaks, totalImperfectHits + countSliderTickMiss);
        aim *= missPenalty(missCount, attrs.aim_difficult_strain_count);
      }
      if (blinds) {
        aim *= 1.3 + totalHits * (0.0016 / (1 + 2 * effectiveMissCount)) * accuracy ** 16 * (1 - 0.003 * difficulty.hp * difficulty.hp);
      } else if (traceable) {
        const sliderFactor = attrs.slider_factor;
        const highArVisibility = 0.5 + sliderFactor ** 6 / 2;
        const lowArVisibility = sliderFactor ** 6;
        let bonus = 0.0275 + 0.025 * (12 - Math.max(approachRate, 7)) * highArVisibility;
        if (approachRate < 7) bonus += 0.025 * (7 - Math.max(approachRate, 0)) * lowArVisibility;
        if (approachRate < 0) bonus += 0.025 * (1 - 1.5 ** approachRate) * lowArVisibility;
        aim *= 1 + bonus;
      }
      aim *= accuracy;
    }

    // Speed.
    let speed = 0;
    if (!relax && speedDeviation != null) {
      const baseSpeed = 4 * attrs.speed_difficulty ** 3;
      speed = baseSpeed;
      if (effectiveMissCount > 0) {
        const missCount = Math.min(effectiveMissCount + speedEstimatedSliderBreaks, totalImperfectHits + countSliderTickMiss);
        speed *= missPenalty(missCount, attrs.speed_difficult_strain_count);
      }
      if (blinds) speed *= 1.12;

      // Speed beyond what this deviation suggests was tapped properly scales
      // down logarithmically.
      const cutoff = 100 + 220 * (22 / speedDeviation) ** 6.5;
      if (baseSpeed > cutoff) {
        const scale = 50;
        let adjusted = scale * (Math.log((baseSpeed - cutoff) / scale + 1) + cutoff / scale);
        const t = 1 - reverseLerp(speedDeviation, 22, 27);
        adjusted += (baseSpeed - adjusted) * t;
        speed *= adjusted / baseSpeed;
      }

      const effectiveHitWindow = 20 * (4 / attrs.speed_difficulty) ** 0.35;
      speed *= erf(effectiveHitWindow / speedDeviation) ** 2;
    }

    // Accuracy, on circles only (and sliders, whose heads are judged like
    // circles, unless CL leaves them out).
    let accuracyValue = 0;
    if (!relax) {
      const objectsWithAccuracy = objectsWithAccuracyBase + (!classicSliderAccuracy || scoreV2 ? sliders : 0);
      if (objectsWithAccuracy > 0) {
        const betterAccuracy = Math.max(
          0,
          ((countGreat - Math.max(totalHits - objectsWithAccuracy, 0)) * 6 + countOk * 2 + countMeh) / (objectsWithAccuracy * 6),
        );
        accuracyValue = 1.52163 ** overallDifficulty * betterAccuracy ** 24 * 2.83;
        accuracyValue *= (objectsWithAccuracy / 1000) ** (objectsWithAccuracy < 1000 ? 0.3 : 0.1);
        if (blinds) accuracyValue *= 1.14;
        else if (traceable) accuracyValue *= 1 + 0.08 * reverseLerp(approachRate, 11.5, 10);
      }
    }

    // Reading and flashlight, combined as cognition.
    let cognition;
    if (typeof attrs.reading_difficulty === 'number') {
      let reading = 4 * attrs.reading_difficulty ** 3;
      if (effectiveMissCount > 0) reading *= missPenalty(effectiveMissCount + aimEstimatedSliderBreaks, estimates.readingDifficultNoteCount);
      reading *= accuracy ** 3;

      let flashlight = 0;
      if (hasMod(mods, 'FL')) {
        flashlight = 25 * (attrs.flashlight_difficulty ?? 0) ** 2;
        if (effectiveMissCount > 0) {
          flashlight *= 0.97 * (1 - (effectiveMissCount / totalHits) ** 0.775) ** (effectiveMissCount ** 0.875);
        }
        if (maxCombo > 0) flashlight *= Math.min(scoreMaxCombo ** 0.8 / maxCombo ** 0.8, 1);
        flashlight *= 0.5 + accuracy / 2;
      }
      cognition = sumCognition(reading, flashlight);
    } else {
      // Only used for SS plays, where reading and flashlight aren't scaled
      // down, so their sum is the cognition the star rating is built from.
      cognition = cognitionFromStarRating(attrs);
    }

    return norm(1.1, aim, speed, accuracyValue, cognition) * multiplier;
  };

  // --- osu!taiko (TaikoPerformanceCalculator.cs), SS only ---

  const taiko = ({ attributes: attrs, beatmap, mods, maximumStatistics }) => {
    const totalHits = maximumStatistics.great ?? 0;
    const starRating = attrs.star_rating;
    // The API currently leaves these out for taiko, and unlike osu!'s reading
    // difficulty they can't be worked out from the star rating.
    if (typeof attrs.rhythm_difficulty !== 'number' || typeof attrs.consistency_factor !== 'number') return null;

    const greatHitWindow = hitWindow(adjustedDifficulty(beatmap, mods, 1).od, 50, 35, 20) / clockRate(mods);
    if (totalHits === 0 || greatHitWindow <= 0) return 0;

    // Upper bound (99% confidence) on unstable rate for a given share of greats.
    const unstableRate = (p) => {
      const n = totalHits;
      const pLowerBound = (n * p + (Z * Z) / 2) / (n + Z * Z) - (Z / (n + Z * Z)) * Math.sqrt(n * p * (1 - p) + (Z * Z) / 4);
      return (greatHitWindow / (Math.SQRT2 * erfInv(pLowerBound))) * 10;
    };
    const estimatedUnstableRate = unstableRate(1);
    const totalDifficultHits = totalHits * attrs.consistency_factor;

    // Score JSON gives converted beatmaps in the ruleset they were played in,
    // flagged with `convert`.
    const isConvert = beatmap.convert === true;
    const isClassic = hasMod(mods, 'CL');
    const hidden = hasMod(mods, 'HD');
    const flashlight = hasMod(mods, 'FL');

    let difficulty = 0;
    if (totalDifficultHits > 0) {
      // At an SS the player is assumed to have played all rhythm difficulty.
      const rhythmMaximumUnstableRate = unstableRate(0.8);
      const rhythmFactor = reverseLerp(attrs.rhythm_difficulty / starRating, 0.15, 0.4);
      const rhythmPenalty =
        1 -
        logistic(
          estimatedUnstableRate,
          (estimatedUnstableRate + rhythmMaximumUnstableRate) / 2,
          10 / (rhythmMaximumUnstableRate - estimatedUnstableRate),
          0.25 * rhythmFactor ** 3,
        );

      const baseDifficulty = 5 * Math.max(1, (starRating * rhythmPenalty) / 0.11) - 4;
      difficulty = Math.min(baseDifficulty ** 3 / 69052.51, baseDifficulty ** 2.25 / 1250);
      difficulty *= 1 + 0.1 * Math.max(0, starRating - 10);

      const lengthBonus = 1 + (0.25 * totalDifficultHits) / (totalDifficultHits + 4000);
      difficulty *= lengthBonus;

      if (hidden) {
        let hiddenBonus = isConvert ? 0.025 : 0.1;
        if (!flashlight) {
          if (!isClassic) hiddenBonus *= 0.2;
          if (hasMod(mods, 'EZ') && isClassic) hiddenBonus *= 0.5;
        }
        difficulty *= 1 + hiddenBonus;
      }

      if (flashlight) difficulty *= Math.max(1, 1.05 - Math.min(attrs.mono_stamina_factor / 50, 1) * lengthBonus);

      const monoAccScalingExponent = 2 + attrs.mono_stamina_factor;
      const monoAccScalingShift = 500 - 100 * (attrs.mono_stamina_factor * 3);
      difficulty *= erf(monoAccScalingShift / (Math.SQRT2 * estimatedUnstableRate)) ** monoAccScalingExponent;
    }

    let accuracy = 470 * 0.9885 ** estimatedUnstableRate;
    accuracy *= 1 + ((50 / estimatedUnstableRate) ** 2 * starRating ** 2.8) / 600;
    if (hidden && !isConvert) accuracy *= 1.075;
    accuracy *= 1 + (0.3 * totalDifficultHits) / (totalDifficultHits + 4000);
    if (flashlight && hidden && !isConvert) accuracy *= Math.max(1, 1.05 * Math.min(1.15, (totalHits / 1500) ** 0.3));

    return difficulty * 1.08 + accuracy * 1.1;
  };

  // --- osu!catch (CatchPerformanceCalculator.cs) ---

  const catchTheBeat = ({ attributes: attrs, beatmap, mods, score }) => {
    const stats = score.statistics;
    const fruits = stats.great ?? 0;
    const droplets = stats.large_tick_hit ?? 0;
    const tinyDroplets = stats.small_tick_hit ?? 0;
    const tinyDropletMisses = stats.small_tick_miss ?? 0;
    const misses = (stats.miss ?? 0) + (stats.large_tick_miss ?? 0);
    const maxCombo = attrs.max_combo;
    const scoreMaxCombo = clamp(score.maxCombo, 0, maxCombo);

    // Accuracy counts every catch the same. Plays entered as an accuracy
    // rather than counts (tiny droplet counts aren't known before a play)
    // give it directly.
    const allHits = fruits + droplets + tinyDroplets + misses + tinyDropletMisses;
    const accuracy = score.accuracy ?? (allHits === 0 ? 0 : clamp((fruits + droplets + tinyDroplets) / allHits, 0, 1));

    let value = (5 * Math.max(1, attrs.star_rating / 0.0049) - 4) ** 2 / 100000;

    // Fruits and droplets; tiny droplets don't count towards combo.
    const comboHits = misses + droplets + fruits;
    const lengthBonus = 0.95 + 0.3 * Math.min(1, comboHits / 2500) + (comboHits > 2500 ? Math.log10(comboHits / 2500) * 0.475 : 0);
    value *= lengthBonus;

    value *= 0.97 ** misses;
    if (maxCombo > 0) value *= Math.min(scoreMaxCombo ** 0.35 / maxCombo ** 0.35, 1);

    const preempt = difficultyRange(adjustedDifficulty(beatmap, mods, 2).ar, 1800, 1200, 450) / clockRate(mods);
    const approachRate = preempt > 1200 ? -(preempt - 1800) / 120 : -(preempt - 1200) / 150 + 5;

    let approachRateFactor = 1;
    if (approachRate > 9) approachRateFactor += 0.1 * (approachRate - 9);
    if (approachRate > 10) approachRateFactor += 0.1 * (approachRate - 10);
    else if (approachRate < 8) approachRateFactor += 0.025 * (8 - approachRate);
    value *= approachRateFactor;

    if (hasMod(mods, 'HD')) {
      if (approachRate <= 10) value *= 1.05 + 0.075 * (10 - approachRate);
      else value *= 1.01 + 0.04 * (11 - Math.min(11, approachRate));
    }

    if (hasMod(mods, 'FL')) value *= 1.35 * lengthBonus;

    value *= accuracy ** 5.5;
    if (hasMod(mods, 'NF')) value *= Math.max(0.9, 1 - 0.02 * misses);

    return value;
  };

  // --- osu!mania (ManiaPerformanceCalculator.cs) ---

  const mania = ({ attributes: attrs, mods, score }) => {
    const stats = score.statistics;
    const [perfect, great, good, ok, meh, miss] = ['perfect', 'great', 'good', 'ok', 'meh', 'miss'].map((j) => stats[j] ?? 0);
    const totalHits = perfect + great + good + ok + meh + miss;
    // pp weights MAX judgements above 300s, unlike either score accuracy.
    const accuracy = totalHits === 0 ? 0 : clamp((perfect * 320 + great * 300 + good * 200 + ok * 100 + meh * 50) / (totalHits * 320), 0, 1);

    let value = 8 * Math.max(attrs.star_rating - 0.15, 0.05) ** 2.2;
    value *= Math.max(0, 5 * accuracy - 4);
    value *= 1 + 0.1 * Math.min(1, totalHits / 1500);
    if (hasMod(mods, 'NF')) value *= 0.75;
    if (hasMod(mods, 'EZ')) value *= 0.5;
    return value;
  };

  const CALCULATORS = [osu, null, catchTheBeat, mania];

  // osu!'s attributes service only understands mods with an osu!stable
  // equivalent, at their default settings (beatmap-attributes.js swaps
  // daycore for half time), and ignores everything else. Plays with any other
  // mod that could change difficulty would get the wrong attributes, so they
  // get no pp instead. The rest of these don't affect difficulty.
  const SUPPORTED_MODS = new Set(['EZ', 'HR', 'DT', 'NC', 'HT', 'DC', 'HD', 'FL', 'TD', 'NF', 'SD', 'PF', 'AC', 'CL', 'SO', 'MR', 'MU', 'FI', '4K', '5K', '6K', '7K', '8K', '9K']);
  const supportsMods = (mods) =>
    mods.every((mod) => {
      if (!SUPPORTED_MODS.has(mod.acronym)) return false;
      const speed = mod.settings?.speed_change;
      return speed == null || speed === RATE_MODS[mod.acronym]?.[1];
    });

  const finite = (pp) => (Number.isFinite(pp) ? pp : null);

  // pp for a play on `beatmap` (the API's or score JSON's beatmap object) in
  // osu! (0), catch (2) or mania (3) with `mods`, from the API's difficulty
  // `attributes` for that same beatmap, ruleset and mods. `score` is
  // { statistics, maxCombo, accuracy }, with statistics keyed like a score's
  // (great, ok, meh, miss, ...). osu! needs `accuracy` and, for plays with FL
  // that aren't SS, attributes from withCognitionSplit; catch and mania work
  // accuracy out from the statistics. Returns null if the ruleset or mods
  // aren't supported.
  const performance = ({ attributes, beatmap, mods, rulesetId, score }) => {
    const calculate = CALCULATORS[rulesetId];
    if (!calculate || !attributes || !beatmap || !score || !supportsMods(mods)) return null;
    return finite(calculate({ attributes, beatmap, mods, rulesetId, score }));
  };

  // pp for an SS of `beatmap` in the given ruleset with `mods`.
  // `maximumStatistics` is the score's maximum_statistics.
  const maxPp = ({ attributes, beatmap, mods, rulesetId, maximumStatistics }) => {
    if (!attributes || !beatmap || !maximumStatistics || !supportsMods(mods)) return null;
    if (rulesetId === 1) return finite(taiko({ attributes, beatmap, mods, maximumStatistics }));

    // osu! scores' maximum statistics don't always list slider ends, but an
    // SS hits every one.
    const statistics =
      rulesetId === 0
        ? { great: beatmap.count_circles + beatmap.count_sliders + beatmap.count_spinners, slider_tail_hit: beatmap.count_sliders }
        : maximumStatistics;
    return performance({ attributes, beatmap, mods, rulesetId, score: { statistics, maxCombo: attributes.max_combo, accuracy: 1 } });
  };

  return { performance, maxPp, withCognitionSplit, supportsMods };
})();
