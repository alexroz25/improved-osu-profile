// The pp calculator in the extension's popup. On an osu! beatmap page, it
// shows what a play on the open difficulty would be worth with the chosen
// mods and accuracy (or hit counts), using the same formulas as max pp
// (pp-calculator.js) and the beatmap's attributes from the osu! API.

const RULESETS = { osu: 0, taiko: 1, fruits: 2, mania: 3 };
const RULESET_NAMES = ['osu!', 'osu!taiko', 'osu!catch', 'osu!mania'];

// Mods offered for each ruleset, with their osu!lazer colour type. Mods that
// don't change pp in a ruleset are left out.
const MODS = {
  0: [['EZ', 'reduction'], ['NF', 'reduction'], ['HT', 'reduction'], ['HR', 'increase'], ['DT', 'increase'], ['HD', 'increase'], ['FL', 'increase'], ['SO', 'automation'], ['TD', 'system'], ['CL', 'conversion']],
  2: [['EZ', 'reduction'], ['NF', 'reduction'], ['HT', 'reduction'], ['HR', 'increase'], ['DT', 'increase'], ['HD', 'increase'], ['FL', 'increase']],
  3: [['EZ', 'reduction'], ['NF', 'reduction'], ['HT', 'reduction'], ['DT', 'increase'], ['CL', 'conversion']],
};
const MOD_NAMES = {
  EZ: 'Easy', NF: 'No Fail', HT: 'Half Time', HR: 'Hard Rock', DT: 'Double Time', HD: 'Hidden',
  FL: 'Flashlight', SO: 'Spun Out', TD: 'Touch Device', CL: 'Classic (stable scoring)',
};
const EXCLUSIVE_MODS = { EZ: 'HR', HR: 'EZ', HT: 'DT', DT: 'HT' };
// Only these change the attributes; leaving the rest out of lookups means
// toggling them doesn't need another request.
const DIFFICULTY_MODS = new Set(['EZ', 'HR', 'DT', 'HT', 'HD', 'FL', 'TD']);

const TABLE_ACCURACIES = [95, 97, 98, 99, 100];

const $ = (id) => document.getElementById(id);
const clamp = (x, min, max) => Math.min(Math.max(x, min), max);
const formatPp = (pp, digits = 2) =>
  pp.toLocaleString(undefined, { minimumFractionDigits: digits, maximumFractionDigits: digits });
const formatAccuracy = (accuracy) => `${(accuracy * 100).toFixed(2)}%`;

const state = {
  beatmap: null,
  rulesetId: 0,
  mods: new Set(),
  // 'accuracy' or 'counts'
  input: 'accuracy',
  // Field name -> what's typed in it; empty fields use their placeholder.
  values: {},
};

// --- Finding the beatmap ---

// The beatmap open in `url`, as { beatmapId, beatmapsetId, mode }, or null if
// it isn't a beatmap page. Beatmapset pages name the difficulty in the hash,
// e.g. /beatmapsets/2171371#osu/4894158.
const beatmapFromUrl = (url) => {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.hostname !== 'osu.ppy.sh') return null;

  const hash = parsed.hash.match(/^#(osu|taiko|fruits|mania)(?:\/(\d+))?/);
  const set = parsed.pathname.match(/^\/(?:beatmapsets|s)\/(\d+)/);
  if (set) return { beatmapsetId: Number(set[1]), beatmapId: hash?.[2] ? Number(hash[2]) : null, mode: hash?.[1] };

  const single = parsed.pathname.match(/^\/(?:beatmaps|b)\/(\d+)/);
  if (single) return { beatmapId: Number(single[1]), mode: parsed.searchParams.get('mode') ?? undefined };
  return null;
};

const loadBeatmap = async ({ beatmapId, beatmapsetId, mode }) => {
  if (beatmapId == null) {
    // No difficulty picked yet: osu! shows the hardest in the set's mode.
    const set = await osuApi.beatmapset(beatmapsetId);
    const candidates = set.beatmaps.filter((b) => mode == null || b.mode === mode);
    beatmapId = (candidates.length ? candidates : set.beatmaps).sort((a, b) => b.difficulty_rating - a.difficulty_rating)[0]?.id;
    if (beatmapId == null) throw new Error('This beatmapset has no difficulties');
  }
  return osuApi.beatmap(beatmapId);
};

// --- Plays ---

const objectCount = (beatmap) => beatmap.count_circles + beatmap.count_sliders + beatmap.count_spinners;

// Reads a field as a whole number of at least 0, or `fallback` if it's empty.
const countValue = (name, fallback = 0) => {
  const value = Number.parseFloat(state.values[name]);
  return Number.isFinite(value) ? Math.max(0, Math.round(value)) : fallback;
};

const accuracyValue = () => {
  const value = Number.parseFloat(state.values.accuracy);
  return Number.isFinite(value) ? clamp(value, 0, 100) / 100 : 1;
};

// osu! hit counts for an accuracy over circles, sliders and spinners (stable
// accuracy), keeping `miss` misses. Ported from osu-tools' simulate command,
// so it splits mistakes into 100s and 50s the same way.
const osuHitsFromAccuracy = (total, accuracy, miss) => {
  miss = clamp(miss, 0, total);
  const relevant = total - miss;
  let ok = 0;
  let meh = 0;
  if (relevant > 0) {
    const relevantAccuracy = clamp((accuracy * total) / relevant, 0, 1);
    if (relevantAccuracy >= 0.25) {
      // More 50s the lower the accuracy.
      const ratio = (1 - (relevantAccuracy - 0.25) / 0.75) ** 2;
      const okEstimate = (6 * relevant * (1 - relevantAccuracy)) / (5 * ratio + 4);
      ok = Math.round(okEstimate);
      meh = Math.round(okEstimate + okEstimate * ratio) - ok;
    } else if (relevantAccuracy >= 1 / 6) {
      // No 300s at all.
      ok = Math.round(6 * relevant * relevantAccuracy - relevant);
      meh = relevant - ok;
    } else {
      // Only 50s, with the rest of the hits missed too.
      meh = Math.round(6 * relevant * relevantAccuracy);
      miss = total - meh;
    }
  }
  return { great: total - ok - meh - miss, ok, meh, miss };
};

// osu!'s score accuracy. Without CL, slider ends (worth half a 300) and
// slider ticks and repeats (a tenth) count too. Every combo point that isn't
// an object or a slider end is a tick or repeat.
const osuAccuracy = (beatmap, maxCombo, statistics, classic) => {
  const { great, ok, meh, miss } = statistics;
  let points = 6 * great + 2 * ok + meh;
  let maxPoints = 6 * (great + ok + meh + miss);
  if (!classic) {
    const ticks = Math.max(0, maxCombo - objectCount(beatmap) - beatmap.count_sliders);
    points += 3 * statistics.slider_tail_hit + 0.6 * (ticks - statistics.large_tick_miss);
    maxPoints += 3 * beatmap.count_sliders + 0.6 * ticks;
  }
  return maxPoints > 0 ? points / maxPoints : 0;
};

const osuPlay = (attributes, accuracyOverride) => {
  const { beatmap } = state;
  const classic = state.mods.has('CL');
  const total = objectCount(beatmap);
  const maxCombo = attributes.max_combo;
  const byAccuracy = accuracyOverride != null || state.input === 'accuracy';

  let statistics;
  let sliderEndMisses = 0;
  let tickMisses = 0;
  if (byAccuracy) {
    // Hit counts whose score accuracy is the one asked for, with every slider
    // end and tick hit.
    let accuracy = accuracyOverride ?? accuracyValue();
    if (!classic) {
      const ticks = Math.max(0, maxCombo - total - beatmap.count_sliders);
      const extra = 3 * beatmap.count_sliders + 0.6 * ticks;
      accuracy = (accuracy * (6 * total + extra) - extra) / (6 * total);
    }
    statistics = osuHitsFromAccuracy(total, accuracy, countValue('miss'));
  } else {
    const [ok, meh, miss] = ['ok', 'meh', 'miss'].map((name) => countValue(name));
    statistics = { great: total - ok - meh - miss, ok, meh, miss };
    if (!classic) {
      sliderEndMisses = Math.min(countValue('sliderEndMiss'), beatmap.count_sliders);
      tickMisses = countValue('tickMiss');
    }
  }
  if (!classic) {
    statistics.slider_tail_hit = beatmap.count_sliders - sliderEndMisses;
    statistics.large_tick_miss = tickMisses;
  }

  return {
    statistics,
    maxCombo: Math.min(countValue('combo', maxCombo), maxCombo),
    accuracy: osuAccuracy(beatmap, maxCombo, statistics, classic),
    valid: statistics.great >= 0,
    total,
  };
};

const catchPlay = (attributes, accuracyOverride) => {
  // Accuracy also counts tiny droplets, which the API doesn't count, so the
  // play is described by accuracy rather than hit counts.
  const maxCombo = attributes.max_combo;
  const miss = Math.min(countValue('miss'), maxCombo);
  const accuracy = accuracyOverride ?? accuracyValue();
  return {
    statistics: { great: maxCombo - miss, miss },
    maxCombo: Math.min(countValue('combo', maxCombo), maxCombo),
    accuracy,
    valid: true,
    total: maxCombo,
  };
};

// Judgements in a mania play: one per note, and two per hold (its start and
// end) unless CL judges holds once. Converted beatmaps make their own notes,
// so for those this is only an estimate.
const maniaJudgementCount = (beatmap, classic) => beatmap.count_circles + beatmap.count_sliders * (classic ? 1 : 2);

const maniaPlay = (attributes, accuracyOverride) => {
  const classic = state.mods.has('CL');
  const total = maniaJudgementCount(state.beatmap, classic);
  // MAX judgements are worth 305 (300 with CL) towards score accuracy.
  const perfectWeight = classic ? 300 : 305;
  let statistics;

  if (accuracyOverride != null || state.input === 'accuracy') {
    // Ported from osu-tools' simulate command: start from all 50s and upgrade
    // as many as possible to MAX, then 300, 200 and 100.
    const accuracy = accuracyOverride ?? accuracyValue();
    const miss = Math.min(countValue('miss'), total);
    const perfectValue = perfectWeight / 5;
    let remaining = total - miss;
    let delta = Math.max(Math.round(accuracy * total * perfectValue) - 10 * remaining, 0);
    const take = (step) => {
      const count = Math.min(Math.floor(delta / step), remaining);
      delta -= count * step;
      remaining -= count;
      return count;
    };
    const perfect = take(perfectValue - 10);
    const great = take(50);
    const good = take(30);
    const ok = take(10);
    statistics = { perfect, great, good, ok, meh: remaining, miss };
  } else {
    const [great, good, ok, meh, miss] = ['great', 'good', 'ok', 'meh', 'miss'].map((name) => countValue(name));
    statistics = { perfect: total - great - good - ok - meh - miss, great, good, ok, meh, miss };
  }

  const { perfect, great, good, ok, meh } = statistics;
  const points = perfectWeight * perfect + 300 * great + 200 * good + 100 * ok + 50 * meh;
  return {
    statistics,
    maxCombo: 0,
    accuracy: total > 0 ? points / (perfectWeight * total) : 0,
    valid: perfect >= 0,
    total,
  };
};

const PLAYS = { 0: osuPlay, 2: catchPlay, 3: maniaPlay };

// --- Attributes ---

const lookup = (mods) => ({
  beatmapId: state.beatmap.id,
  rulesetId: state.rulesetId,
  mods: mods.filter((acronym) => DIFFICULTY_MODS.has(acronym)).map((acronym) => ({ acronym })),
});

// The attributes pp is calculated from, or null while they load. osu! plays
// with FL also need the attributes without it, to tell reading and
// flashlight apart (see ppCalculator.withCognitionSplit).
const attributeLookups = () => {
  const mods = [...state.mods];
  const lookups = [lookup(mods)];
  if (state.rulesetId === 0 && state.mods.has('FL')) lookups.push(lookup(mods.filter((m) => m !== 'FL')));
  return lookups;
};

const currentAttributes = () => {
  const [attributes, withoutFlashlight = undefined] = attributeLookups().map((l) => beatmapAttributes.get(l));
  if (attributes == null || withoutFlashlight === null) return null;
  return state.rulesetId === 0 ? ppCalculator.withCognitionSplit(attributes, withoutFlashlight) : attributes;
};

// --- Rendering ---

// Takes text and link() elements rather than HTML, so error messages from
// osu! are never parsed as markup.
const showMessage = (...parts) => {
  $('calculator').hidden = true;
  $('message').hidden = false;
  $('message').replaceChildren(...parts);
};

const link = (text, href) => {
  const a = document.createElement('a');
  a.textContent = text;
  a.href = href;
  a.target = '_blank';
  return a;
};

const optionsLink = (text) => {
  const a = link(text, '#');
  a.removeAttribute('target');
  a.addEventListener('click', (event) => {
    event.preventDefault();
    chrome.runtime.openOptionsPage();
  });
  return a;
};

const showCredentialsMessage = () =>
  showMessage('The calculator needs your osu! API credentials. ', optionsLink('Set them up in the options'), '.');

const savePreferences = () => {
  chrome.storage.local.set({ calculator: { mods: [...state.mods], input: state.input } }).catch(() => {});
};

const renderMods = () => {
  const container = $('mods');
  container.replaceChildren(
    ...MODS[state.rulesetId].map(([acronym, type]) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = `mod mod--${type}`;
      button.textContent = acronym;
      button.title = MOD_NAMES[acronym];
      button.setAttribute('aria-pressed', String(state.mods.has(acronym)));
      button.addEventListener('click', () => {
        if (state.mods.has(acronym)) {
          state.mods.delete(acronym);
        } else {
          state.mods.add(acronym);
          state.mods.delete(EXCLUSIVE_MODS[acronym]);
        }
        savePreferences();
        renderMods();
        // CL changes which hit counts osu! and mania judge.
        renderFields();
      });
      return button;
    }),
  );
};

// Fields for the current ruleset and input: [name, label, colour, options].
const fieldDefinitions = () => {
  const classic = state.mods.has('CL');
  const accuracy = ['accuracy', 'Accuracy (%)', null, { step: 0.01, max: 100, placeholder: '100' }];
  const combo = ['combo', 'Combo', null, { placeholder: 'max' }];
  const miss = ['miss', 'Misses', 'miss'];

  if (state.rulesetId === 2) return [accuracy, miss, combo];
  if (state.rulesetId === 3) {
    if (state.input === 'accuracy') return [accuracy, miss];
    return [
      ['perfect', 'MAX', 'perfect', { readOnly: true }],
      ['great', '300', 'great'],
      ['good', '200', 'good'],
      ['ok', '100', 'ok'],
      ['meh', '50', 'meh'],
      miss,
    ];
  }
  if (state.input === 'accuracy') return [accuracy, miss, combo];
  return [
    ['great', '300', 'great', { readOnly: true }],
    ['ok', '100', 'ok'],
    ['meh', '50', 'meh'],
    miss,
    combo,
    // Lazer judges slider ends and ticks too; with CL they only cost combo.
    ...(classic ? [] : [['sliderEndMiss', 'Slider end misses'], ['tickMiss', 'Slider tick misses']]),
  ];
};

const renderFields = () => {
  const hasCounts = state.rulesetId !== 2;
  $('input-tabs').hidden = !hasCounts;
  for (const tab of $('input-tabs').querySelectorAll('button')) {
    tab.setAttribute('aria-selected', String(tab.dataset.input === state.input));
  }

  $('fields').replaceChildren(
    ...fieldDefinitions().map(([name, label, colour, options = {}]) => {
      const field = document.createElement('label');
      field.className = `field${colour ? ` field--${colour}` : ''}${name === 'accuracy' ? ' field--wide' : ''}`;
      field.append(label);

      const input = document.createElement('input');
      input.type = 'number';
      input.min = '0';
      input.step = String(options.step ?? 1);
      if (options.max != null) input.max = String(options.max);
      input.placeholder = options.placeholder ?? '0';
      input.name = name;
      input.readOnly = Boolean(options.readOnly);
      input.tabIndex = options.readOnly ? -1 : 0;
      if (!options.readOnly) input.value = state.values[name] ?? '';
      input.addEventListener('input', () => {
        state.values[name] = input.value;
        update();
      });
      field.append(input);
      return field;
    }),
  );
  update();
};

const ppOf = (attributes, play) =>
  ppCalculator.performance({
    attributes,
    beatmap: state.beatmap,
    mods: [...state.mods].map((acronym) => ({ acronym })),
    rulesetId: state.rulesetId,
    score: play,
  });

const update = () => {
  if (beatmapAttributes.isUnavailable()) {
    showCredentialsMessage();
    return;
  }

  const attributes = currentAttributes();
  const stars = $('beatmap-stars');
  const table = $('accuracy-table');
  if (attributes == null) {
    const failed = attributeLookups().some((l) => beatmapAttributes.hasFailed(l));
    stars.textContent = '';
    $('result-pp').textContent = failed ? '–' : '…';
    $('result-detail').textContent = failed
      ? "Couldn't load this beatmap's difficulty from osu!. Try reopening the calculator."
      : 'Loading beatmap difficulty…';
    table.replaceChildren();
    return;
  }

  stars.textContent = `★ ${attributes.star_rating.toFixed(2)}`;
  const buildPlay = PLAYS[state.rulesetId];
  const play = buildPlay(attributes);

  // Fill in the hit count the others leave over.
  const remainder = state.rulesetId === 0 ? 'great' : 'perfect';
  const remainderInput = $('fields').querySelector(`input[name="${remainder}"]`);
  if (remainderInput) remainderInput.value = String(play.statistics[remainder]);

  const pp = play.valid ? ppOf(attributes, play) : null;
  const estimated = isEstimate(attributes, play);
  $('result-pp').textContent = pp == null ? '–' : `${estimated ? '~' : ''}${formatPp(pp)}`;

  const detail = [];
  if (!play.valid) detail.push(`More hits than the beatmap has (${play.total.toLocaleString()})`);
  else {
    detail.push(formatAccuracy(play.accuracy));
    if (state.rulesetId !== 3) detail.push(`${play.maxCombo.toLocaleString()}x / ${attributes.max_combo.toLocaleString()}x`);
    if (state.input === 'accuracy' && state.rulesetId !== 2) {
      const counts = Object.entries(play.statistics)
        .filter(([key, count]) => count > 0 && !['great', 'perfect', 'slider_tail_hit', 'large_tick_miss', 'miss'].includes(key))
        .map(([key, count]) => `${count.toLocaleString()}×${{ ok: '100', meh: '50', good: '200' }[key]}`);
      if (counts.length) detail.push(counts.join(' '));
    }
  }
  $('result-detail').textContent = detail.join(' · ');

  // pp at a few accuracies, keeping the misses and combo entered.
  const row = (cells, tag) => {
    const tr = document.createElement('tr');
    tr.append(
      ...cells.map((text) => {
        const cell = document.createElement(tag);
        cell.textContent = text;
        return cell;
      }),
    );
    return tr;
  };
  const tableCells = TABLE_ACCURACIES.map((accuracy) => {
    const tablePlay = buildPlay(attributes, accuracy / 100);
    const value = ppOf(attributes, tablePlay);
    if (value == null) return '–';
    return `${isEstimate(attributes, tablePlay) ? '~' : ''}${formatPp(value, 0)}pp`;
  });
  table.replaceChildren(row(TABLE_ACCURACIES.map((accuracy) => `${accuracy}%`), 'th'), row(tableCells, 'td'));
};

// Whether a play's pp may differ from osu!'s.
const isEstimate = (attributes, play) => {
  if (state.rulesetId === 0) {
    // Without CL, only misses and missed ticks count as combo breaks.
    const { miss, large_tick_miss: tickMisses = 0 } = play.statistics;
    const classic = state.mods.has('CL');
    // osu! works out CL combo breaks from the play's score, so they're
    // estimated from combo here.
    if (classic && (miss > 0 || play.maxCombo < attributes.max_combo)) return true;
    // The osu! API leaves out part of what the miss penalty uses.
    if (miss > 0 || tickMisses > 0) return true;
  }
  // Converted mania beatmaps make their own notes, so their count is a guess.
  return state.rulesetId === 3 && state.beatmap.mode_int !== 3;
};

// --- Start ---

const start = async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const page = tab?.url ? beatmapFromUrl(tab.url) : null;
  if (!page) {
    showMessage('Open a beatmap on ', link('osu.ppy.sh', 'https://osu.ppy.sh/beatmapsets'), ' to calculate its pp.');
    return;
  }

  const { clientId, clientSecret, calculator } = await chrome.storage.local.get(['clientId', 'clientSecret', 'calculator']);
  if (!clientId || !clientSecret) {
    showCredentialsMessage();
    return;
  }

  showMessage('Loading…');
  let beatmap;
  try {
    beatmap = await loadBeatmap(page);
  } catch (error) {
    if (error instanceof osuApi.CredentialsError) showCredentialsMessage();
    else showMessage(`Couldn't load this beatmap from osu! (${error.message}).`);
    return;
  }

  // Beatmaps can be played in their own ruleset or, from osu!, converted.
  const rulesetId = RULESETS[page.mode] ?? beatmap.mode_int;
  if (rulesetId === 1) {
    showMessage("Taiko isn't supported yet: the osu! API doesn't give everything taiko's pp formula needs.");
    return;
  }

  state.beatmap = { ...beatmap, convert: rulesetId !== beatmap.mode_int };
  state.rulesetId = rulesetId;
  const offered = new Set(MODS[rulesetId].map(([acronym]) => acronym));
  state.mods = new Set((calculator?.mods ?? []).filter((acronym) => offered.has(acronym)));
  if (calculator?.input === 'counts' && rulesetId !== 2) state.input = 'counts';

  const { beatmapset } = beatmap;
  $('beatmap-title').textContent = `${beatmapset.artist} - ${beatmapset.title}`;
  $('beatmap-title').title = $('beatmap-title').textContent;
  $('beatmap-version').textContent = `${RULESET_NAMES[rulesetId]}${state.beatmap.convert ? ' (converted)' : ''} · ${beatmap.version}`;
  $('beatmap-version').title = $('beatmap-version').textContent;
  $('message').hidden = true;
  $('calculator').hidden = false;

  for (const tab of $('input-tabs').querySelectorAll('button')) {
    tab.addEventListener('click', () => {
      state.input = tab.dataset.input;
      savePreferences();
      renderFields();
    });
  }

  beatmapAttributes.subscribe(update);
  renderMods();
  renderFields();
};

start();
