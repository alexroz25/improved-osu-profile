// The pp a play would be worth as an SS (100% accuracy, full combo) with the
// same mods, for each ruleset.
//
// Ported from osu!'s performance calculators (osu.Game.Rulesets.*/Difficulty/
// *PerformanceCalculator.cs, as of the 2026 Q2 SR & PP release), with the
// score fixed to an SS. That removes everything to do with misses, combo and
// accuracy, which keeps this much shorter than the original. The difficulty
// attributes come from the osu! API, so only these formulas need updating when
// osu! changes how pp is awarded; star rating changes arrive on their own.
//
// To check changes: a ranked SS play's pp is its max pp, so results should
// match the pp of real SS plays. Stable mania SS plays are the exception:
// their 300s count as 100% accuracy, but pp rewards MAX judgements more.

const ppCalculator = (() => {
  // --- Shared helpers (osu.Game/Rulesets/Difficulty/Utils/DiffUtils.cs) ---

  const clamp = (x, min, max) => Math.min(Math.max(x, min), max);
  const norm = (p, ...values) => values.reduce((sum, x) => sum + x ** p, 0) ** (1 / p);
  const reverseLerp = (x, start, end) => clamp((x - start) / (end - start), 0, 1);
  const logistic = (x, midpointOffset, multiplier, maxValue = 1) => maxValue / (1 + Math.exp(multiplier * (midpointOffset - x)));

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

  // Lower bound (99% confidence) on the share of greats when all n hits are
  // greats, i.e. the Wilson score interval at p = 1.
  const perfectProportionLowerBound = (n) => n / (n + Z * Z);

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

  const osu = ({ attributes: attrs, beatmap, mods }) => {
    const circles = beatmap.count_circles;
    const sliders = beatmap.count_sliders;
    const spinners = beatmap.count_spinners;
    const totalHits = circles + sliders + spinners;

    const rate = clockRate(mods);
    const difficulty = adjustedDifficulty(beatmap, mods, 0);
    const greatHitWindow = hitWindow(difficulty.od, 80, 50, 20) / rate;
    const okHitWindow = hitWindow(difficulty.od, 140, 100, 60) / rate;
    const overallDifficulty = (79.5 - greatHitWindow) / 6;
    const preempt = difficultyRange(difficulty.ar, PREEMPT_MAX, PREEMPT_MID, PREEMPT_MIN) / rate;
    const approachRate = inverseDifficultyRange(preempt, PREEMPT_MAX, PREEMPT_MID, PREEMPT_MIN);

    const relax = hasMod(mods, 'RX');
    const blinds = hasMod(mods, 'BL');
    const traceable = hasMod(mods, 'TC');
    const classicSliderAccuracy = hasMod(mods, 'CL') && modSetting(mods, 'CL', 'no_slider_head_accuracy') !== false;
    const scoreV2 = hasMod(mods, 'SV2');

    // Aim. At an SS every slider is followed, so there's no slider nerf.
    let aim = 0;
    if (!hasMod(mods, 'AP')) {
      aim = 4 * attrs.aim_difficulty ** 3;
      aim *= 0.95 + 0.35 * Math.min(1, totalHits / 2000) + (totalHits > 2000 ? Math.log10(totalHits / 2000) * 0.5 : 0);
      if (blinds) {
        aim *= 1.3 + totalHits * 0.0016 * (1 - 0.003 * difficulty.hp * difficulty.hp);
      } else if (traceable) {
        const sliderFactor = attrs.slider_factor;
        const highArVisibility = 0.5 + sliderFactor ** 6 / 2;
        const lowArVisibility = sliderFactor ** 6;
        let bonus = 0.0275 + 0.025 * (12 - Math.max(approachRate, 7)) * highArVisibility;
        if (approachRate < 7) bonus += 0.025 * (7 - Math.max(approachRate, 0)) * lowArVisibility;
        if (approachRate < 0) bonus += 0.025 * (1 - 1.5 ** approachRate) * lowArVisibility;
        aim *= 1 + bonus;
      }
    }

    // Speed, scaled by the tap deviation an SS implies at this OD, treating
    // all speed notes as circles.
    let speed = 0;
    if (!relax && totalHits > 0) {
      const speedNotes = attrs.speed_note_count + (totalHits - attrs.speed_note_count) * 0.1;
      const pLowerBound = perfectProportionLowerBound(Math.max(1, speedNotes));
      let deviation = okHitWindow / Math.sqrt(3);
      if (pLowerBound > 0.01) {
        deviation = greatHitWindow / (Math.SQRT2 * erfInv(pLowerBound));
        const okTail =
          (Math.sqrt(2 / Math.PI) * okHitWindow * Math.exp(-0.5 * (okHitWindow / deviation) ** 2)) /
          (deviation * erf(okHitWindow / (Math.SQRT2 * deviation)));
        deviation *= Math.sqrt(1 - okTail);
      }

      const baseSpeed = 4 * attrs.speed_difficulty ** 3;
      speed = baseSpeed;
      if (blinds) speed *= 1.12;

      // Speed beyond what this deviation suggests was tapped properly scales
      // down logarithmically.
      const cutoff = 100 + 220 * (22 / deviation) ** 6.5;
      if (baseSpeed > cutoff) {
        const scale = 50;
        let adjusted = scale * (Math.log((baseSpeed - cutoff) / scale + 1) + cutoff / scale);
        const t = 1 - reverseLerp(deviation, 22, 27);
        adjusted += (baseSpeed - adjusted) * t;
        speed *= adjusted / baseSpeed;
      }

      const effectiveHitWindow = 20 * (4 / attrs.speed_difficulty) ** 0.35;
      speed *= erf(effectiveHitWindow / deviation) ** 2;
    }

    // Accuracy. Classic mod leaves slider heads out of accuracy.
    let accuracy = 0;
    if (!relax) {
      const objectsWithAccuracy = circles + (!classicSliderAccuracy || scoreV2 ? sliders : 0);
      if (objectsWithAccuracy > 0) {
        accuracy = 1.52163 ** overallDifficulty * 2.83;
        accuracy *= (objectsWithAccuracy / 1000) ** (objectsWithAccuracy < 1000 ? 0.3 : 0.1);
        if (blinds) accuracy *= 1.14;
        else if (traceable) accuracy *= 1 + 0.08 * reverseLerp(approachRate, 11.5, 10);
      }
    }

    // Reading and flashlight, combined as "cognition" (OsuDifficultyCalculator
    // .SumCognitionDifficulty). At an SS this is the same cognition value the
    // star rating is built from.
    let cognition;
    if (typeof attrs.reading_difficulty === 'number') {
      const reading = 4 * attrs.reading_difficulty ** 3;
      const flashlight = hasMod(mods, 'FL') ? 25 * (attrs.flashlight_difficulty ?? 0) ** 2 : 0;
      cognition = reading;
      if (reading <= 0) cognition = flashlight;
      else if (flashlight > 0) cognition = norm(1.1, reading, flashlight * clamp(flashlight / reading, 0.25, 1));
    } else {
      // The API currently leaves out reading_difficulty (and with FL,
      // flashlight_difficulty), but star rating is
      // cbrt(1.12 × norm(aim, speed, cognition)) over the same aim and speed
      // values it does give, so cognition can be recovered from it.
      const basePerformance = attrs.star_rating ** 3 / 1.12;
      const rest = basePerformance ** 1.1 - (4 * attrs.aim_difficulty ** 3) ** 1.1 - (4 * attrs.speed_difficulty ** 3) ** 1.1;
      cognition = Math.max(0, rest) ** (1 / 1.1);
    }

    let multiplier = 1.12;
    if (hasMod(mods, 'SO') && totalHits > 0) multiplier *= 1 - (spinners / totalHits) ** 0.85;

    return norm(1.1, aim, speed, accuracy, cognition) * multiplier;
  };

  // --- osu!taiko (TaikoPerformanceCalculator.cs) ---

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

  const catchTheBeat = ({ attributes: attrs, beatmap, mods, maximumStatistics }) => {
    // Fruits and droplets; tiny droplets don't count towards combo.
    const comboHits = (maximumStatistics.great ?? 0) + (maximumStatistics.large_tick_hit ?? 0);

    let value = (5 * Math.max(1, attrs.star_rating / 0.0049) - 4) ** 2 / 100000;

    const lengthBonus = 0.95 + 0.3 * Math.min(1, comboHits / 2500) + (comboHits > 2500 ? Math.log10(comboHits / 2500) * 0.475 : 0);
    value *= lengthBonus;

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

    return value;
  };

  // --- osu!mania (ManiaPerformanceCalculator.cs) ---

  const mania = ({ attributes: attrs, mods, maximumStatistics }) => {
    const totalHits = ['perfect', 'great', 'good', 'ok', 'meh', 'miss'].reduce((sum, j) => sum + (maximumStatistics[j] ?? 0), 0);

    let value = 8 * Math.max(attrs.star_rating - 0.15, 0.05) ** 2.2 * (1 + 0.1 * Math.min(1, totalHits / 1500));
    if (hasMod(mods, 'NF')) value *= 0.75;
    if (hasMod(mods, 'EZ')) value *= 0.5;
    return value;
  };

  const CALCULATORS = [osu, taiko, catchTheBeat, mania];

  // osu!'s attributes service only understands mods with an osu!stable
  // equivalent, at their default settings (beatmap-attributes.js swaps
  // daycore for half time), and ignores everything else. Plays with any other
  // mod that could change difficulty would get the wrong attributes, so they
  // get no max pp instead. The rest of these don't affect difficulty.
  const SUPPORTED_MODS = new Set(['EZ', 'HR', 'DT', 'NC', 'HT', 'DC', 'HD', 'FL', 'TD', 'NF', 'SD', 'PF', 'AC', 'CL', 'SO', 'MR', 'MU', 'FI', '4K', '5K', '6K', '7K', '8K', '9K']);
  const supportsMods = (mods) =>
    mods.every((mod) => {
      if (!SUPPORTED_MODS.has(mod.acronym)) return false;
      const speed = mod.settings?.speed_change;
      return speed == null || speed === RATE_MODS[mod.acronym]?.[1];
    });

  // pp for an SS of `beatmap` (the score JSON's beatmap object) in the given
  // ruleset with `mods`, from the API's difficulty `attributes` for that same
  // beatmap, ruleset and mods. `maximumStatistics` is the score's
  // maximum_statistics. Returns null if something needed is missing or the
  // attributes can't account for the mods.
  const maxPp = ({ attributes, beatmap, mods, rulesetId, maximumStatistics }) => {
    const calculate = CALCULATORS[rulesetId];
    if (!calculate || !attributes || !beatmap || !maximumStatistics || !supportsMods(mods)) return null;
    const pp = calculate({ attributes, beatmap, mods, rulesetId, maximumStatistics });
    return Number.isFinite(pp) ? pp : null;
  };

  return { maxPp };
})();
