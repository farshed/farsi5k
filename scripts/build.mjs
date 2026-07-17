import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';

const PAGE_ROOT = 'Wiktionary:Frequency_lists/Persian/Miller_Aghajanian-Stewart_2009';
const RANGES = ['1-1000', '1001-2000', '2001-3000', '3001-4000', '4001-5000'];
const APIS = RANGES.map((range) =>
  `https://en.wiktionary.org/w/api.php?action=parse&page=${encodeURIComponent(`${PAGE_ROOT}/${range}`)}&prop=text&format=json&formatversion=2`
);
const SOURCE = `https://en.wiktionary.org/wiki/${PAGE_ROOT.replaceAll(' ', '_')}_(index)`;
const TATOEBA = 'https://downloads.tatoeba.org/exports/per_language/pes/pes_sentences_detailed.tsv.bz2';
const TATOEBA_LINKS = 'https://downloads.tatoeba.org/exports/per_language/pes/pes-eng_links.tsv.bz2';
const TATOEBA_ENGLISH = 'https://downloads.tatoeba.org/exports/per_language/eng/eng_sentences.tsv.bz2';

const entities = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', hellip: '…' };
const decode = (value) => value
  .replace(/&#(x?[0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n.replace(/^x/i, ''), /^x/i.test(n) ? 16 : 10)))
  .replace(/&([a-z]+);/gi, (_, n) => entities[n] ?? `&${n};`);
const text = (value) => decode(value
  .replace(/<br\s*\/?\s*>/gi, ' ')
  .replace(/<sup[^>]*>[\s\S]*?<\/sup>/gi, '')
  .replace(/<[^>]+>/g, ' ')
  .replace(/\s+/g, ' ')
  .trim());

const [sourcePages, tatoebaResponse, linksResponse, englishResponse] = await Promise.all([
  Promise.all(APIS.map(async (api) => {
      const response = await fetch(api, { headers: { 'User-Agent': 'Persian5000Reference/1.0 (educational static page)' } });
      if (!response.ok) throw new Error(`Source request failed: ${response.status}`);
      const payload = await response.json();
      if (!payload.parse?.text) throw new Error('A source page did not contain parsed HTML.');
      return payload.parse.text;
  })),
  fetch(TATOEBA, { headers: { 'User-Agent': 'Persian5000Reference/1.0 (educational static page)' } }),
  fetch(TATOEBA_LINKS, { headers: { 'User-Agent': 'Persian5000Reference/1.0 (educational static page)' } }),
  fetch(TATOEBA_ENGLISH, { headers: { 'User-Agent': 'Persian5000Reference/1.0 (educational static page)' } })
]);
if (!tatoebaResponse.ok) throw new Error(`Tatoeba request failed: ${tatoebaResponse.status}`);
if (!linksResponse.ok) throw new Error(`Tatoeba links request failed: ${linksResponse.status}`);
if (!englishResponse.ok) throw new Error(`Tatoeba English request failed: ${englishResponse.status}`);

const tables = sourcePages.map((sourceHtml) =>
  [...sourceHtml.matchAll(/<table[^>]*class="[^"]*wikitable[^"]*"[^>]*>([\s\S]*?)<\/table>/gi)][0]?.[1]
);
if (tables.some((table) => !table)) throw new Error('Could not find every frequency table.');

const words = [];
for (const row of tables.flatMap((table) => [...table.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)])) {
  const cells = [...row[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map((m) => m[1]);
  if (cells.length < 4) continue;
  const rank = Number(text(cells[0]));
  if (!Number.isInteger(rank)) continue;
  const persian = text(cells[1].match(/<a[^>]*>([\s\S]*?)<\/a>/i)?.[1] ?? cells[1]).replace(/\s*\([^)]*\)\s*$/, '');
  const ipaMatches = [...cells[1].matchAll(/<span[^>]*class="[^"]*IPA[^"]*"[^>]*>([\s\S]*?)<\/span>/gi)];
  let pronunciation = text(ipaMatches[0]?.[1] ?? '');
  if (!pronunciation) pronunciation = text(cells[1]).match(/\(([^()]*)\)\s*$/)?.[1] ?? '';
  let definition = text(cells.at(-2));
  let partOfSpeech = text(cells.at(-1));
  const mergedPos = !partOfSpeech && definition.match(/ (q|expression)$/);
  if (mergedPos) {
    definition = definition.slice(0, -mergedPos[0].length);
    partOfSpeech = mergedPos[1] === 'q' ? 'quantifier' : mergedPos[1];
  }
  words.push({ rank, persian, pronunciation, definition, partOfSpeech });
}

words.sort((a, b) => a.rank - b.rank);
if (words.length !== 5000) throw new Error(`Expected 5000 entries, parsed ${words.length}.`);

const normalizePersian = (value) => value
  .normalize('NFC')
  .replace(/[يى]/g, 'ی')
  .replace(/ك/g, 'ک')
  .replace(/[\u064B-\u065F\u0670]/g, '')
  .replace(/\s+/g, ' ')
  .trim();
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
let generatedTranslations = {};
try {
  generatedTranslations = JSON.parse(await readFile(resolve(root, 'data/persian-only-translations.json'), 'utf8'));
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}
const decompress = async (response, maxBuffer) => execFileSync('bzip2', ['-dc'], {
  input: Buffer.from(await response.arrayBuffer()), maxBuffer
}).toString('utf8');
const [tatoebaTsv, linksTsv, englishTsv] = await Promise.all([
  decompress(tatoebaResponse, 20 * 1024 * 1024),
  decompress(linksResponse, 20 * 1024 * 1024),
  decompress(englishResponse, 256 * 1024 * 1024)
]);
const links = linksTsv.trim().split('\n').map((line) => line.split('\t').map(Number));
const neededEnglishIds = new Set(links.map(([, englishId]) => englishId));
const englishById = new Map();
for (const line of englishTsv.split('\n')) {
  const [id, , sentence] = line.split('\t');
  if (neededEnglishIds.has(Number(id)) && sentence) englishById.set(Number(id), sentence.trim());
}
const translationByPersianId = new Map();
for (const [persianId, englishId] of links) {
  const translation = englishById.get(englishId);
  const current = translationByPersianId.get(persianId);
  if (translation && (!current || Math.abs(translation.length - 62) < Math.abs(current.length - 62))) {
    translationByPersianId.set(persianId, translation);
  }
}
const sentenceByToken = new Map();
const translatedByToken = new Map();
const allSentences = [];
const translatedSentences = [];
const addCandidate = (map, token, candidate) => {
  const current = map.get(token);
  if (!current || Math.abs(candidate.sentence.length - 62) < Math.abs(current.sentence.length - 62)) map.set(token, candidate);
};
for (const line of tatoebaTsv.split('\n')) {
  const [id, , rawSentence] = line.split('\t');
  const sentence = normalizePersian(rawSentence ?? '');
  const translation = translationByPersianId.get(Number(id)) ?? '';
  if (!id || sentence.length < 12 || sentence.length > 150 || !/[آ-ی]/.test(sentence)) continue;
  const candidate = { sentence, translation };
  allSentences.push(candidate);
  if (translation) translatedSentences.push(candidate);
  for (const token of new Set(sentence.match(/[\p{L}\p{M}\u200c]+/gu) ?? [])) {
    addCandidate(sentenceByToken, token, candidate);
    if (translation) addCandidate(translatedByToken, token, candidate);
  }
}
const boundaryMatch = (sentence, phrase) => {
  const at = sentence.indexOf(phrase);
  if (at < 0) return false;
  const letter = /[\p{L}\p{M}\p{N}\u200c]/u;
  return !letter.test(sentence[at - 1] ?? '') && !letter.test(sentence[at + phrase.length] ?? '');
};
let authenticExamples = 0;
let bilingualExamples = 0;
let persianOnlyExamples = 0;
const choose = (options, rank) => options[rank % options.length];
const fallbackTemplates = {
  verb: [
    (word, meaning) => [`برای ${word} باید برنامهٔ روشنی داشت.`, `To ${meaning}, one needs a clear plan.`],
    (word, meaning) => [`او دربارهٔ روش درست ${word} پرسید.`, `They asked about the right way to ${meaning}.`],
    (word, meaning) => [`هدف اصلی گروه ${word} بود.`, `The group's main goal was to ${meaning}.`],
    (word, meaning) => [`یادگیری شیوهٔ ${word} زمان می‌برد.`, `Learning how to ${meaning} takes time.`],
    (word, meaning) => [`${word} به دقت و تجربه نیاز دارد.`, `${meaning} requires care and experience.`]
  ],
  adjective: [
    (word, meaning) => [`کارشناسان این وضعیت را ${word} توصیف کردند.`, `The experts described the situation as ${meaning}.`],
    (word, meaning) => [`این تصمیم در آن زمان ${word} به نظر می‌رسید.`, `The decision seemed ${meaning} at the time.`],
    (word, meaning) => [`نتیجهٔ نهایی کاملاً ${word} بود.`, `The final result was completely ${meaning}.`],
    (word, meaning) => [`آن‌ها با مسئله‌ای ${word} روبه‌رو شدند.`, `They encountered a ${meaning} problem.`],
    (word, meaning) => [`همه بر جنبهٔ ${word} موضوع تأکید کردند.`, `Everyone emphasized the ${meaning} aspect of the issue.`]
  ],
  adverb: [
    (word, meaning) => [`او ${word} به پرسش پاسخ داد.`, `They answered the question ${meaning}.`],
    (word, meaning) => [`گروه ${word} کار خود را ادامه داد.`, `The group continued its work ${meaning}.`],
    (word, meaning) => [`آن‌ها ${word} نتیجه را اعلام کردند.`, `They announced the result ${meaning}.`],
    (word, meaning) => [`این موضوع ${word} بررسی خواهد شد.`, `This issue will be examined ${meaning}.`]
  ],
  proper: [
    (word, meaning) => [`نام ${word} در گزارش امروز آمده است.`, `The name ${meaning} appears in today's report.`],
    (word, meaning) => [`دربارهٔ ${word} اطلاعات تازه‌ای منتشر شد.`, `New information about ${meaning} was published.`],
    (word, meaning) => [`${word} در این رویداد حضور داشت.`, `${meaning} was present at this event.`]
  ],
  noun: [
    (word, meaning) => [`دربارهٔ ${word} در جلسه صحبت کردیم.`, `We discussed ${meaning} in the meeting.`],
    (word, meaning) => [`${word} در این گزارش اهمیت ویژه‌ای دارد.`, `${meaning} has particular importance in this report.`],
    (word, meaning) => [`پژوهشگران ${word} را با دقت بررسی کردند.`, `The researchers carefully examined ${meaning}.`],
    (word, meaning) => [`اطلاعات تازه‌ای دربارهٔ ${word} منتشر شد.`, `New information about ${meaning} was published.`],
    (word, meaning) => [`او برای شناخت بهتر ${word} مطالعه کرد.`, `They studied to better understand ${meaning}.`]
  ],
  pronoun: [
    (word, meaning) => [`در این ماجرا، ${word} نقش مهمی داشت.`, `${meaning} played an important role in this story.`],
    (word, meaning) => [`همه دربارهٔ ${word} پرسیدند.`, `Everyone asked about ${meaning}.`],
    (word, meaning) => [`تصمیم نهایی را ${word} گرفت.`, `${meaning} made the final decision.`]
  ],
  connector: [
    (word, meaning) => [`نویسنده از ${word} برای پیوند دو بخش جمله استفاده کرد.`, `The writer used ${meaning} to connect two parts of the sentence.`],
    (word, meaning) => [`در متن امروز، ${word} میان دو عبارت آمده است.`, `In today's text, ${meaning} appears between two phrases.`],
    (word, meaning) => [`با افزودن ${word}، معنای جمله روشن‌تر شد.`, `Adding ${meaning} made the sentence clearer.`]
  ],
  other: [
    (word, meaning) => [`کاربرد ${word} در این متن روشن است.`, `The use of ${meaning} is clear in this text.`],
    (word, meaning) => [`معلم برای توضیح موضوع از ${word} استفاده کرد.`, `The teacher used ${meaning} to explain the topic.`],
    (word, meaning) => [`${word} در گفت‌وگوی امروز به کار رفت.`, `${meaning} was used in today's conversation.`]
  ]
};
const makeFallback = (word, target) => {
  const pos = word.partOfSpeech.toLowerCase();
  const meaning = word.definition.split(',')[0].replace(/[.;]+$/, '').trim();
  const type = pos.includes('proper noun') ? 'proper'
    : pos.includes('verb') ? 'verb'
    : pos.includes('adjective') ? 'adjective'
    : pos.includes('adverb') ? 'adverb'
    : pos.includes('pronoun') ? 'pronoun'
    : pos.includes('preposition') || pos.includes('conjunction') || pos.includes('particle') ? 'connector'
    : pos.includes('noun') ? 'noun'
    : 'other';
  return choose(fallbackTemplates[type], word.rank)(target, meaning);
};
for (const word of words) {
  const target = normalizePersian(word.persian);
  word.persian = target;
  let match = target.includes(' ')
    ? translatedSentences.find(({ sentence }) => boundaryMatch(sentence, target))
      ?? allSentences.find(({ sentence }) => boundaryMatch(sentence, target))
    : translatedByToken.get(target) ?? sentenceByToken.get(target);
  if (match) {
    authenticExamples++;
    if (!match.translation && generatedTranslations[match.sentence]) match.translation = generatedTranslations[match.sentence];
    if (match.translation) bilingualExamples++;
    else persianOnlyExamples++;
  }
  const [fallbackSentence, fallbackTranslation] = makeFallback(word, target);
  match ??= {
    sentence: fallbackSentence,
    translation: fallbackTranslation
  };
  Object.assign(word, { example: match.sentence, exampleTranslation: match.translation });
}

const data = JSON.stringify(words.map(({ rank, persian, pronunciation, definition, partOfSpeech, example, exampleTranslation }) =>
  [rank, persian, pronunciation, definition, partOfSpeech, example, exampleTranslation]
)).replace(/</g, '\\u003c');
const page = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="description" content="The 5,000 most frequent Persian words with pronunciation, meaning, and part of speech.">
  <title>پنج هزار واژه · 5,000 Essential Persian Words</title>
  <style>
    :root { --ink:#13201d; --muted:#66736f; --paper:#f4f1e9; --card:#fffdf8; --line:#d9d9ce; --green:#173f35; --acid:#d8ff64; --orange:#ff785a; --shadow:0 18px 50px rgba(26,47,40,.09); }
    * { box-sizing:border-box; }
    html { scroll-behavior:smooth; }
    body { margin:0; background:var(--paper); color:var(--ink); font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; }
    button,input { font:inherit; }
    a { color:inherit; }
    .hero { background:var(--green); color:#fff; overflow:hidden; position:relative; }
    .hero:after { content:"۵۰۰۰"; position:absolute; right:-.04em; bottom:-.33em; color:rgba(216,255,100,.08); font:900 clamp(12rem,34vw,32rem)/1 sans-serif; pointer-events:none; }
    .hero-inner,.main { width:min(1180px,calc(100% - 40px)); margin:auto; position:relative; z-index:1; }
    .hero-copy { padding:72px 0 78px; max-width:820px; }
    .eyebrow { color:var(--acid); text-transform:uppercase; letter-spacing:.16em; font-weight:800; font-size:.72rem; }
    h1 { margin:16px 0 20px; font-size:clamp(3rem,8vw,7.5rem); line-height:.87; letter-spacing:-.065em; max-width:900px; }
    h1 .fa { display:block; direction:rtl; text-align:left; font-family:Tahoma,"Noto Naskh Arabic",serif; font-weight:500; letter-spacing:0; line-height:1.05; color:var(--acid); }
    .intro { margin:0; max-width:670px; color:#d8e2df; line-height:1.7; font-size:clamp(1rem,2vw,1.17rem); }
    .hero-source { margin-top:38px; padding-left:16px; border-left:3px solid var(--acid); max-width:720px; color:#aebfba; font-size:.8rem; line-height:1.6; }
    .hero-source a { color:#fff; text-decoration:none; }
    .hero-source a:hover { color:var(--acid); }
    .main { padding:38px 0 80px; }
    .controls { position:sticky; top:12px; z-index:10; display:grid; grid-template-columns:1fr auto; gap:12px; padding:12px; background:rgba(255,253,248,.86); border:1px solid rgba(217,217,206,.9); border-radius:18px; box-shadow:var(--shadow); backdrop-filter:blur(18px); }
    .search-wrap { position:relative; }
    .search-icon { position:absolute; left:17px; top:50%; transform:translateY(-50%); color:var(--muted); }
    #search { width:100%; height:52px; border:0; outline:0; border-radius:12px; background:#eeeee6; padding:0 18px 0 48px; color:var(--ink); }
    #search:focus { box-shadow:inset 0 0 0 2px var(--green); background:white; }
    .random { height:52px; padding:0 19px; border:0; border-radius:12px; background:var(--acid); color:var(--green); font-weight:800; cursor:pointer; }
    .random:hover { filter:brightness(.95); transform:translateY(-1px); }
    .filter-row { grid-column:1/-1; display:flex; align-items:center; gap:8px; overflow:auto; padding:1px 2px 2px; scrollbar-width:none; }
    .filter-row::-webkit-scrollbar { display:none; }
    .chip { flex:none; border:1px solid var(--line); background:transparent; color:var(--muted); padding:7px 12px; border-radius:999px; font-size:.78rem; cursor:pointer; }
    .chip.active { background:var(--green); border-color:var(--green); color:white; }
    .results-bar { display:flex; justify-content:space-between; align-items:end; gap:20px; padding:34px 3px 16px; }
    .results-bar h2 { margin:0; font-size:clamp(1.5rem,3vw,2.25rem); letter-spacing:-.04em; }
    #count { color:var(--muted); font-size:.86rem; }
    .ipa-help { color:var(--muted); font-size:.78rem; text-align:right; max-width:460px; line-height:1.5; }
    .word-list { display:grid; grid-template-columns:1fr; gap:12px; }
    .word-card { display:grid; grid-template-columns:92px minmax(140px,190px) minmax(140px,200px) 1fr; grid-template-areas:"rank word definition example"; align-items:center; gap:18px; background:var(--card); border:1px solid var(--line); border-radius:16px; padding:14px 18px; transition:transform .18s ease,border-color .18s ease,box-shadow .18s ease; }
    .word-card:hover { transform:translateY(-2px); border-color:#b9c5bd; box-shadow:0 12px 30px rgba(26,47,40,.07); }
    .rank-cell { grid-area:rank; align-self:start; display:flex; flex-direction:column; align-items:flex-start; gap:15px; padding-top:5px; }
    .rank { color:#8b9692; font:700 .72rem/1 ui-monospace,SFMono-Regular,Menlo,monospace; }
    .word-info { grid-area:word; min-width:0; }
    .persian { margin:0; direction:rtl; text-align:left; font-family:Tahoma,"Noto Naskh Arabic",serif; font-size:clamp(1.75rem,3vw,2.45rem); font-weight:500; line-height:1.2; }
    .pronunciation { margin-top:5px; color:var(--green); font:600 .87rem/1.3 ui-monospace,SFMono-Regular,Menlo,monospace; }
    .definition { grid-area:definition; min-width:0; }
    .meaning { color:#354640; font-size:1.3rem; font-weight:650; line-height:1.3; letter-spacing:-.015em; }
    .example { grid-area:example; min-width:0; direction:rtl; text-align:right; display:flex; align-items:center; gap:12px; padding-left:20px; border-left:1px solid #e0e1d7; color:#263a33; font-family:Tahoma,"Noto Naskh Arabic",serif; font-size:1.15rem; line-height:1.65; }
    .sentence { flex:1; }
    .sentence[dir="ltr"] { text-align:left; font-family:Inter,ui-sans-serif,system-ui,sans-serif; font-size:1.02rem; line-height:1.65; }
    .example strong { color:var(--green); background:linear-gradient(transparent 58%,rgba(216,255,100,.8) 58%); font-weight:800; }
    .translation-toggle { flex:0 0 34px; width:34px; height:34px; display:grid; place-items:center; border:1px solid #cdd2c9; border-radius:50%; background:#f2f3eb; color:var(--green); font-weight:800; font-size:.68rem; cursor:pointer; }
    .translation-toggle:hover { background:var(--acid); border-color:var(--acid); transform:rotate(-6deg); }
    .translation-toggle:focus-visible { outline:2px solid var(--green); outline-offset:2px; }
    .pos { display:inline-block; background:#eef0e8; color:#65706b; border-radius:999px; padding:4px 6px; max-width:78px; text-align:center; font-size:.5rem; line-height:1.2; text-transform:uppercase; letter-spacing:.04em; overflow-wrap:anywhere; }
    .empty { grid-column:1/-1; text-align:center; padding:70px 20px; background:var(--card); border:1px dashed var(--line); border-radius:18px; }
    .load-more { display:block; margin:26px auto 0; border:1px solid var(--green); color:var(--green); background:transparent; border-radius:12px; padding:13px 24px; font-weight:800; cursor:pointer; }
    .load-more:hover { background:var(--green); color:white; }
    footer { border-top:1px solid var(--line); padding:30px 0 44px; color:var(--muted); font-size:.78rem; line-height:1.6; }
    footer .main { padding:0; display:flex; justify-content:space-between; gap:30px; }
    footer a { text-underline-offset:2px; }
    .random-flash { animation:flash 1.1s ease; }
    @keyframes flash { 0%,100% { box-shadow:none; } 30% { box-shadow:0 0 0 5px var(--orange),0 16px 38px rgba(26,47,40,.14); transform:translateY(-3px); } }
    @media (max-width:820px) { .hero-inner,.main { width:min(100% - 24px,1180px); } .hero-copy { padding:50px 0 58px; } .controls { top:6px; grid-template-columns:1fr auto; } .random { width:52px; padding:0; font-size:0; } .random:after { content:"↗"; font-size:1.15rem; } .word-card { grid-template-columns:76px 1fr; grid-template-areas:"rank word" ". definition" ". example"; align-items:start; padding:14px; gap:8px 10px; } .rank-cell { padding-top:8px; gap:12px; } .pos { max-width:66px; } .example { margin-top:3px; padding:9px 0 0; border-left:0; border-top:1px solid #e0e1d7; } .ipa-help { display:none; } footer .main { flex-direction:column; } }
    @media print { .hero { color:#000; background:white; } .hero:after,.controls,.load-more,.translation-toggle { display:none!important; } .hero-copy { padding:28px 0; } h1 { font-size:40px; } h1 .fa,.eyebrow { color:#000; } .intro { color:#333; } .hero-source,.hero-source a { color:#333; } .main { width:100%; padding:15px; } .word-list { grid-template-columns:1fr; gap:5px; } .word-card { min-height:0; break-inside:avoid; padding:9px; border-radius:4px; grid-template-columns:65px 110px 1fr; grid-template-areas:"rank word example"; } .persian { font-size:20px; } .definition { display:none; } .pos { font-size:7px; padding:3px 5px; } .example { padding-left:10px; font-size:11px; } }
  </style>
</head>
<body>
  <header class="hero">
    <div class="hero-inner">
      <div class="hero-copy">
        <h1><span class="fa" lang="fa">پنج هزار واژه</span>5,000 words.</h1>
        <p class="intro">The most-used Persian words, ranked by frequency.</p>
        <div class="hero-source">Source: <a href="${SOURCE}" target="_blank" rel="noreferrer"><cite>A Frequency Dictionary of Persian: Core Vocabulary for Learners</cite> by Corey Miller and Karineh Aghajanian-Stewart (Routledge, 2009)</a></div>
      </div>
    </div>
  </header>
  <main class="main">
    <section class="controls" aria-label="Word filters">
      <div class="search-wrap"><span class="search-icon" aria-hidden="true">⌕</span><input id="search" type="search" placeholder="Search فارسی, pronunciation, or meaning…" autocomplete="off" aria-label="Search words"></div>
      <button class="random" id="random" type="button">Random word ↗</button>
      <div class="filter-row" id="filters" aria-label="Filter by part of speech"></div>
    </section>
    <div class="results-bar"><div><h2>Frequency list</h2><div id="count" aria-live="polite"></div></div><div class="ipa-help">Quick IPA: <b>ɒ</b> ≈ “a” in father · <b>æ</b> ≈ “a” in cat · <b>ʃ</b> = sh · <b>ʒ</b> = “s” in vision · <b>x</b> = Persian خ</div></div>
    <section class="word-list" id="list" aria-label="Persian word list"></section>
    <button class="load-more" id="more" type="button">Show 100 more</button>
  </main>
  <footer><div class="main"><span>Frequency data: Miller & Aghajanian-Stewart (2009), via Wiktionary.<br>Corpus examples © <a href="https://tatoeba.org" target="_blank" rel="noreferrer">Tatoeba contributors</a>, licensed under <a href="https://creativecommons.org/licenses/by/2.0/fr/" target="_blank" rel="license noreferrer">CC BY 2.0 FR</a>.</span><span>Tip: press <b>/</b> to search · Designed for screen and print.</span></div></footer>
  <script>
    const WORDS = ${data};
    const state = { query:'', pos:'All', limit:100 };
    const list = document.querySelector('#list'), count = document.querySelector('#count'), more = document.querySelector('#more');
    const POS_CATEGORIES = ['noun','verb','adjective','adverb','pronoun','preposition','conjunction'];
    const posParts = value => value.toLowerCase().split(',').map(part => part.trim());
    const matchesPos = (value,category) => category==='Other' ? !POS_CATEGORIES.some(part=>posParts(value).includes(part)) : posParts(value).includes(category.toLowerCase());
    const categories = ['All', ...POS_CATEGORIES.filter(category=>WORDS.some(([, , , , pos])=>matchesPos(pos,category))), ...(WORDS.some(([, , , , pos])=>matchesPos(pos,'Other'))?['Other']:[])];
    document.querySelector('#filters').innerHTML = categories.map(p => '<button type="button" class="chip'+(p==='All'?' active':'')+'" data-pos="'+p+'">'+p+'</button>').join('');
    const safe = (s) => String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
    const isWordChar = char => char ? /[\\p{L}\\p{M}\\p{N}\\u200c]/u.test(char) : false;
    function highlight(sentence,word){ let html='',start=0,cursor=0,at;while((at=sentence.indexOf(word,cursor))!==-1){const before=sentence[at-1],after=sentence[at+word.length];if(!isWordChar(before)&&!isWordChar(after)){html+=safe(sentence.slice(start,at))+'<strong>'+safe(word)+'</strong>';start=at+word.length;cursor=start;}else{cursor=at+word.length;}}return html+safe(sentence.slice(start)); }
    function filtered(){ const q=state.query.trim().toLocaleLowerCase(); return WORDS.filter(([rank,word,sound,meaning,pos,example,translation]) => (state.pos==='All'||matchesPos(pos,state.pos)) && (!q||[word,sound,meaning,pos,example,translation,String(rank)].some(v=>v.toLocaleLowerCase().includes(q)))); }
    function card([rank,word,sound,meaning,pos,example,translation]){ const toggle=translation?'<button class="translation-toggle" type="button" data-rank="'+rank+'" aria-pressed="false" aria-label="Show English translation" title="Show English translation">EN</button>':'';return '<article class="word-card" id="word-'+rank+'"><div class="rank-cell"><span class="rank">#'+String(rank).padStart(4,'0')+'</span><span class="pos">'+safe(pos)+'</span></div><div class="word-info"><h3 class="persian" lang="fa">'+safe(word)+'</h3><div class="pronunciation">/'+safe(sound)+'/</div></div><div class="definition"><div class="meaning">'+safe(meaning)+'</div></div><div class="example"><span class="sentence" lang="fa" dir="rtl">'+highlight(example,word)+'</span>'+toggle+'</div></article>'; }
    function render(){ const matches=filtered(), shown=matches.slice(0,state.limit); count.textContent = matches.length.toLocaleString()+' '+(matches.length===1?'entry':'entries'); list.innerHTML=shown.length?shown.map(card).join(''):'<div class="empty"><strong>No words found.</strong><br>Try a broader spelling or another category.</div>'; more.hidden=shown.length>=matches.length; more.textContent='Show '+Math.min(100,matches.length-shown.length)+' more'; }
    document.querySelector('#search').addEventListener('input',e=>{state.query=e.target.value;state.limit=100;render();});
    document.querySelector('#filters').addEventListener('click',e=>{const b=e.target.closest('[data-pos]');if(!b)return;state.pos=b.dataset.pos;state.limit=100;document.querySelectorAll('.chip').forEach(x=>x.classList.toggle('active',x===b));render();});
    more.addEventListener('click',()=>{state.limit+=100;render();});
    list.addEventListener('click',e=>{const button=e.target.closest('.translation-toggle');if(!button)return;const rank=Number(button.dataset.rank),entry=WORDS[rank-1],sentence=button.previousElementSibling,isEnglish=button.getAttribute('aria-pressed')==='true';if(isEnglish){sentence.innerHTML=highlight(entry[5],entry[1]);sentence.lang='fa';sentence.dir='rtl';button.textContent='EN';button.setAttribute('aria-pressed','false');button.setAttribute('aria-label','Show English translation');button.title='Show English translation';}else{sentence.textContent=entry[6];sentence.lang='en';sentence.dir='ltr';button.textContent='فا';button.setAttribute('aria-pressed','true');button.setAttribute('aria-label','Show Persian sentence');button.title='Show Persian sentence';}});
    document.querySelector('#random').addEventListener('click',()=>{state.query='';state.pos='All';state.limit=WORDS.length;document.querySelector('#search').value='';document.querySelectorAll('.chip').forEach(x=>x.classList.toggle('active',x.dataset.pos==='All'));render();const [rank]=WORDS[Math.floor(Math.random()*WORDS.length)],el=document.querySelector('#word-'+rank);el.scrollIntoView({behavior:'smooth',block:'center'});el.classList.add('random-flash');setTimeout(()=>el.classList.remove('random-flash'),1200);});
    document.addEventListener('keydown',e=>{if(e.key==='/'&&document.activeElement.tagName!=='INPUT'){e.preventDefault();document.querySelector('#search').focus();}});
    render();
  </script>
</body>
</html>`;

await writeFile(resolve(root, 'index.html'), page, 'utf8');
console.log(`Built index.html with ${words.length} entries; ${bilingualExamples} bilingual, ${persianOnlyExamples} Persian-only, ${words.length - authenticExamples} generated examples.`);
