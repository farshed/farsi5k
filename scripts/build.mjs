import { writeFile } from 'node:fs/promises';
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

const [sourcePages, tatoebaResponse] = await Promise.all([
  Promise.all(APIS.map(async (api) => {
      const response = await fetch(api, { headers: { 'User-Agent': 'Persian5000Reference/1.0 (educational static page)' } });
      if (!response.ok) throw new Error(`Source request failed: ${response.status}`);
      const payload = await response.json();
      if (!payload.parse?.text) throw new Error('A source page did not contain parsed HTML.');
      return payload.parse.text;
  })),
  fetch(TATOEBA, { headers: { 'User-Agent': 'Persian5000Reference/1.0 (educational static page)' } })
]);
if (!tatoebaResponse.ok) throw new Error(`Tatoeba request failed: ${tatoebaResponse.status}`);

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
const tatoebaTsv = execFileSync('bzip2', ['-dc'], {
  input: Buffer.from(await tatoebaResponse.arrayBuffer()),
  maxBuffer: 20 * 1024 * 1024
}).toString('utf8');
const sentenceByToken = new Map();
const allSentences = [];
for (const line of tatoebaTsv.split('\n')) {
  const [id, , rawSentence, author = ''] = line.split('\t');
  const sentence = normalizePersian(rawSentence ?? '');
  if (!id || sentence.length < 12 || sentence.length > 150 || !/[آ-ی]/.test(sentence)) continue;
  const candidate = { sentence, id: Number(id), author };
  allSentences.push(candidate);
  for (const token of new Set(sentence.match(/[آ-ی]+(?:‌[آ-ی]+)*/g) ?? [])) {
    const current = sentenceByToken.get(token);
    if (!current || Math.abs(sentence.length - 62) < Math.abs(current.sentence.length - 62)) sentenceByToken.set(token, candidate);
  }
}
const boundaryMatch = (sentence, phrase) => {
  const at = sentence.indexOf(phrase);
  if (at < 0) return false;
  const letter = /[آ-ی‌]/;
  return !letter.test(sentence[at - 1] ?? '') && !letter.test(sentence[at + phrase.length] ?? '');
};
let authenticExamples = 0;
for (const word of words) {
  const target = normalizePersian(word.persian);
  word.persian = target;
  let match = target.includes(' ')
    ? allSentences.find(({ sentence }) => boundaryMatch(sentence, target))
    : sentenceByToken.get(target);
  if (match) authenticExamples++;
  const kind = word.partOfSpeech.includes('verb') ? 'فعل' : target.includes(' ') ? 'عبارت' : 'واژه';
  match ??= { sentence: `در این درس، ${kind} «${target}» را در جمله به کار می‌بریم.`, id: 0, author: '' };
  Object.assign(word, { example: match.sentence, exampleId: match.id, exampleAuthor: match.author });
}

const data = JSON.stringify(words.map(({ rank, persian, pronunciation, definition, partOfSpeech, example }) =>
  [rank, persian, pronunciation, definition, partOfSpeech, example]
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
    nav { padding:24px 0; display:flex; align-items:center; justify-content:space-between; border-bottom:1px solid rgba(255,255,255,.16); }
    .brand { display:flex; align-items:center; gap:11px; font-weight:800; letter-spacing:-.02em; }
    .brand-mark { width:32px; height:32px; display:grid; place-items:center; border-radius:50%; background:var(--acid); color:var(--green); }
    .source-link { color:#dce7e3; font-size:.86rem; text-decoration:none; }
    .source-link:hover { color:var(--acid); }
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
    .word-list { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:12px; }
    .word-card { min-height:190px; display:grid; grid-template-columns:48px 1fr auto; align-items:center; gap:18px; background:var(--card); border:1px solid var(--line); border-radius:18px; padding:22px; transition:transform .18s ease,border-color .18s ease,box-shadow .18s ease; }
    .word-card:hover { transform:translateY(-2px); border-color:#b9c5bd; box-shadow:0 12px 30px rgba(26,47,40,.07); }
    .rank { align-self:start; color:#8b9692; font:700 .72rem/1 ui-monospace,SFMono-Regular,Menlo,monospace; padding-top:7px; }
    .persian { margin:0; direction:rtl; text-align:left; font-family:Tahoma,"Noto Naskh Arabic",serif; font-size:clamp(1.75rem,3vw,2.45rem); font-weight:500; line-height:1.2; }
    .pronunciation { margin-top:5px; color:var(--green); font:600 .87rem/1.3 ui-monospace,SFMono-Regular,Menlo,monospace; }
    .meaning { margin-top:9px; color:var(--muted); font-size:.86rem; line-height:1.35; }
    .example { direction:rtl; text-align:right; margin-top:14px; padding-top:12px; border-top:1px solid #e8e7de; color:#33423d; font-family:Tahoma,"Noto Naskh Arabic",serif; font-size:.92rem; line-height:1.8; }
    .example strong { color:var(--green); background:linear-gradient(transparent 58%,rgba(216,255,100,.8) 58%); font-weight:800; }
    .pos { align-self:start; background:#eef0e8; color:#65706b; border-radius:999px; padding:6px 9px; max-width:108px; text-align:center; font-size:.65rem; line-height:1.2; text-transform:uppercase; letter-spacing:.05em; }
    .empty { grid-column:1/-1; text-align:center; padding:70px 20px; background:var(--card); border:1px dashed var(--line); border-radius:18px; }
    .load-more { display:block; margin:26px auto 0; border:1px solid var(--green); color:var(--green); background:transparent; border-radius:12px; padding:13px 24px; font-weight:800; cursor:pointer; }
    .load-more:hover { background:var(--green); color:white; }
    footer { border-top:1px solid var(--line); padding:30px 0 44px; color:var(--muted); font-size:.78rem; line-height:1.6; }
    footer .main { padding:0; display:flex; justify-content:space-between; gap:30px; }
    .random-flash { animation:flash 1.1s ease; }
    @keyframes flash { 0%,100% { box-shadow:none; } 30% { box-shadow:0 0 0 5px var(--orange),0 16px 38px rgba(26,47,40,.14); transform:translateY(-3px); } }
    @media (max-width:760px) { .hero-inner,.main { width:min(100% - 24px,1180px); } nav { padding:18px 0; } .source-link { display:none; } .hero-copy { padding:50px 0 58px; } .hero-stats { gap:20px; } .controls { top:6px; grid-template-columns:1fr auto; } .random { width:52px; padding:0; font-size:0; } .random:after { content:"↗"; font-size:1.15rem; } .word-list { grid-template-columns:1fr; } .word-card { grid-template-columns:38px 1fr; padding:19px 16px; gap:12px; } .pos { grid-column:2; justify-self:start; margin-top:-7px; } .ipa-help { display:none; } footer .main { flex-direction:column; } }
    @media print { .hero { color:#000; background:white; } .hero:after,.controls,.load-more { display:none!important; } .hero-copy { padding:28px 0; } h1 { font-size:40px; } h1 .fa,.eyebrow { color:#000; } .intro { color:#333; } .hero-source,.hero-source a { color:#333; } .main { width:100%; padding:15px; } .word-list { grid-template-columns:repeat(2,1fr); gap:5px; } .word-card { min-height:0; break-inside:avoid; padding:9px; border-radius:4px; grid-template-columns:25px 1fr; } .persian { font-size:20px; } .meaning,.pos { display:none; } .example { font-size:11px; } }
  </style>
</head>
<body>
  <header class="hero">
    <div class="hero-inner">
      <nav><div class="brand"><span class="brand-mark">ف</span> Persian essentials</div><a class="source-link" href="${SOURCE}" target="_blank" rel="noreferrer">Corpus & methodology ↗</a></nav>
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
  <footer><div class="main"><span>Frequency data: Miller & Aghajanian-Stewart (2009), via Wiktionary.</span><span>Tip: press <b>/</b> to search · Designed for screen and print.</span></div></footer>
  <script>
    const WORDS = ${data};
    const state = { query:'', pos:'All', limit:100 };
    const list = document.querySelector('#list'), count = document.querySelector('#count'), more = document.querySelector('#more');
    const broadPos = (value) => ['noun','verb','adjective','adverb','pronoun','preposition','conjunction'].find(p => value.toLowerCase().includes(p)) || 'Other';
    const categories = ['All', ...new Set(WORDS.map(([, , , , pos]) => broadPos(pos)))];
    document.querySelector('#filters').innerHTML = categories.map(p => '<button type="button" class="chip'+(p==='All'?' active':'')+'" data-pos="'+p+'">'+p+'</button>').join('');
    const safe = (s) => String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
    const highlight = (sentence,word) => sentence.split(word).map(safe).join('<strong>'+safe(word)+'</strong>');
    function filtered(){ const q=state.query.trim().toLocaleLowerCase(); return WORDS.filter(([rank,word,sound,meaning,pos,example]) => (state.pos==='All'||broadPos(pos)===state.pos) && (!q||[word,sound,meaning,pos,example,String(rank)].some(v=>v.toLocaleLowerCase().includes(q)))); }
    function card([rank,word,sound,meaning,pos,example]){ return '<article class="word-card" id="word-'+rank+'"><span class="rank">#'+String(rank).padStart(4,'0')+'</span><div><h3 class="persian" lang="fa">'+safe(word)+'</h3><div class="pronunciation">/'+safe(sound)+'/</div><div class="meaning">'+safe(meaning)+'</div><div class="example" lang="fa">'+highlight(example,word)+'</div></div><span class="pos">'+safe(pos)+'</span></article>'; }
    function render(){ const matches=filtered(), shown=matches.slice(0,state.limit); count.textContent = matches.length.toLocaleString()+' '+(matches.length===1?'entry':'entries'); list.innerHTML=shown.length?shown.map(card).join(''):'<div class="empty"><strong>No words found.</strong><br>Try a broader spelling or another category.</div>'; more.hidden=shown.length>=matches.length; more.textContent='Show '+Math.min(100,matches.length-shown.length)+' more'; }
    document.querySelector('#search').addEventListener('input',e=>{state.query=e.target.value;state.limit=100;render();});
    document.querySelector('#filters').addEventListener('click',e=>{const b=e.target.closest('[data-pos]');if(!b)return;state.pos=b.dataset.pos;state.limit=100;document.querySelectorAll('.chip').forEach(x=>x.classList.toggle('active',x===b));render();});
    more.addEventListener('click',()=>{state.limit+=100;render();});
    document.querySelector('#random').addEventListener('click',()=>{state.query='';state.pos='All';state.limit=WORDS.length;document.querySelector('#search').value='';document.querySelectorAll('.chip').forEach(x=>x.classList.toggle('active',x.dataset.pos==='All'));render();const [rank]=WORDS[Math.floor(Math.random()*WORDS.length)],el=document.querySelector('#word-'+rank);el.scrollIntoView({behavior:'smooth',block:'center'});el.classList.add('random-flash');setTimeout(()=>el.classList.remove('random-flash'),1200);});
    document.addEventListener('keydown',e=>{if(e.key==='/'&&document.activeElement.tagName!=='INPUT'){e.preventDefault();document.querySelector('#search').focus();}});
    render();
  </script>
</body>
</html>`;

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
await writeFile(resolve(root, 'index.html'), page, 'utf8');
console.log(`Built index.html with ${words.length} entries (${words[0].persian} → ${words.at(-1).persian}); ${authenticExamples} authentic examples.`);
