'use strict';

/* =====================================================================
   Série — registro rápido de treino (PWA)
   ---------------------------------------------------------------------
   Estrutura do arquivo:
     1. Camada de dados  → salvarSerie() / removerSerie()  ← trocar pelo Supabase
     2. Fila de sincronização (offline-first)
     3. Estado e utilidades
     4. Telas: início, treino, exercício, histórico, sheet "novo exercício"
     5. Navegação, eventos globais e service worker
   ===================================================================== */


/* =====================================================================
   1. CAMADA DE DADOS
   ---------------------------------------------------------------------
   Cada toque em "Registrar série" gera exatamente UM objeto neste formato
   (uma linha da tabela "series"):

     {
       id:           'uuid',
       criado_em:    '2026-10-31T18:42:10.123Z',   // timestamp ISO
       dia_treino:   'A' | 'B' | 'C' | 'D',
       exercicio:    'Supino reto',
       numero_serie: 3,
       repeticoes:   10,
       carga_kg:     62.5 | null
     }

   Para migrar ao Supabase, troque SÓ o corpo das duas funções abaixo.
   Se elas lançarem erro, a operação fica na fila e é reenviada depois.
   ===================================================================== */

const CHAVES = {
  tabela:     'serie.tabela_series',   // simula a tabela "series" do servidor
  cache:      'serie.cache_series',    // cópia local que a interface lê (funciona offline)
  fila:       'serie.fila_sync',       // operações ainda não enviadas
  exercicios: 'serie.exercicios',      // { A: [...], B: [...], C: [...], D: [...] }
  ultimoDia:  'serie.ultimo_dia',
};

const store = {
  ler(chave, padrao) {
    try {
      const v = localStorage.getItem(chave);
      return v == null ? padrao : JSON.parse(v);
    } catch (e) { return padrao; }
  },
  gravar(chave, valor) {
    try { localStorage.setItem(chave, JSON.stringify(valor)); }
    catch (e) { console.warn('Falha ao gravar no localStorage', e); }
  },
};

const SUPABASE_URL = 'https://oxakvkbodlmkeaijtodi.supabase.co';
const SUPABASE_KEY = 'sb_publishable_bWGQ4gLLbKzrfc9D64rWHA_ok-7rmE-';
const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);

/** Persiste UMA série no Supabase (upsert: reenvio é seguro). */
async function salvarSerie(serie) {
  const { error } = await sb.from('series').upsert(serie, { onConflict: 'id' });
  if (error) throw error;
}

/** Remove uma série (usado pelo "Desfazer"). */
async function removerSerie(id) {
  const { error } = await sb.from('series').delete().eq('id', id);
  if (error) throw error;
}


/* =====================================================================
   2. FILA DE SINCRONIZAÇÃO (offline-first)
   A interface sempre grava primeiro no cache local (instantâneo) e
   enfileira o envio. A fila é processada quando há conexão.
   ===================================================================== */

let cache = store.ler(CHAVES.cache, []);
let fila = store.ler(CHAVES.fila, []);
let sincronizando = false;
let erroSync = false;
let retryTimer = null;

function gravarCache() { store.gravar(CHAVES.cache, cache); }
function gravarFila() { store.gravar(CHAVES.fila, fila); }

function enfileirarInsert(serie) {
  fila.push({ op: 'insert', serie });
  gravarFila();
}

function enfileirarDelete(id) {
  // Se o insert ainda não foi enviado, basta tirá-lo da fila.
  const i = fila.findIndex((o) => o.op === 'insert' && o.serie.id === id);
  if (i >= 0) fila.splice(i, 1);
  else fila.push({ op: 'delete', id });
  gravarFila();
}

function idsPendentes() {
  return new Set(fila.filter((o) => o.op === 'insert').map((o) => o.serie.id));
}

async function processarFila() {
  if (sincronizando) return;
  if (!navigator.onLine) { atualizarSync(); return; }
  if (!fila.length) { erroSync = false; atualizarSync(); return; }

  sincronizando = true;
  atualizarSync();
  try {
    while (fila.length) {
      const op = fila[0];
      if (op.op === 'insert') await salvarSerie(op.serie);
      else if (op.op === 'delete') await removerSerie(op.id);
      fila.shift();
      gravarFila();
    }
    erroSync = false;
  } catch (e) {
    console.warn('Sincronização falhou, tentando de novo em breve', e);
    erroSync = true;
    clearTimeout(retryTimer);
    retryTimer = setTimeout(processarFila, 15000);
  } finally {
    sincronizando = false;
    atualizarSync();
    if (estado.tela === 'historico') renderHistorico();
  }
}

function atualizarSync() {
  const n = fila.length;
  let classe = '';
  let texto = 'Salvo';
  let aria = 'Tudo salvo';

  if (!navigator.onLine && n > 0) {
    classe = 'is-offline';
    texto = `Sem conexão · ${n} p/ enviar`;
    aria = `Sem conexão. ${n} ${n === 1 ? 'série será enviada' : 'séries serão enviadas'} depois.`;
  } else if (!navigator.onLine) {
    classe = 'is-offline';
    texto = 'Sem conexão';
    aria = 'Sem conexão. Novos registros serão enviados depois.';
  } else if (sincronizando) {
    classe = 'is-sending';
    texto = 'Enviando…';
    aria = 'Enviando registros';
  } else if (erroSync && n > 0) {
    classe = 'is-error';
    texto = 'Erro · tentando de novo';
    aria = 'Erro ao enviar. Tentando de novo em instantes.';
  }

  document.querySelectorAll('.sync').forEach((el) => {
    el.className = 'sync ' + classe;
    el.setAttribute('aria-label', aria);
    el.innerHTML = '<span class="dot" aria-hidden="true"></span><span></span>';
    el.lastChild.textContent = texto;
  });
}


/* =====================================================================
   3. ESTADO E UTILIDADES
   ===================================================================== */

const DIAS = ['A', 'B', 'C', 'D'];

const estado = {
  tela: 'inicio',
  dia: null,
  exercicio: null,
  reps: 10,
  carga: null,      // número ou null (campo vazio)
  semCarga: false,
  filtroDia: 'todos',
  filtroEx: 'todos',
};

let exerciciosPorDia = Object.assign({ A: [], B: [], C: [], D: [] }, store.ler(CHAVES.exercicios, {}));

const $ = (sel) => document.querySelector(sel);

function uuid() {
  if (crypto.randomUUID) return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

const pad2 = (n) => String(n).padStart(2, '0');
function chaveData(dataOuIso) {
  const d = dataOuIso instanceof Date ? dataOuIso : new Date(dataOuIso);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}
const hojeChave = () => chaveData(new Date());

function capitalizar(s) { return s.charAt(0).toUpperCase() + s.slice(1); }

function dataCurta(d) {
  // "qui, 29 out"
  const sem = d.toLocaleDateString('pt-BR', { weekday: 'short' }).replace('.', '');
  const mes = d.toLocaleDateString('pt-BR', { month: 'short' }).replace('.', '');
  return `${sem}, ${d.getDate()} ${mes}`;
}

function rotuloData(chave) {
  const [a, m, d] = chave.split('-').map(Number);
  const data = new Date(a, m - 1, d);
  const ontem = new Date(); ontem.setDate(ontem.getDate() - 1);
  if (chave === hojeChave()) return `Hoje · ${dataCurta(data)}`;
  if (chave === chaveData(ontem)) return `Ontem · ${dataCurta(data)}`;
  return dataCurta(data);
}

function fmtKg(n) {
  return Number(n).toLocaleString('pt-BR', { maximumFractionDigits: 2 });
}

function fmtSerie(reps, carga) {
  return carga == null ? `${reps} reps` : `${reps} × ${fmtKg(carga)} kg`;
}

function lerNumero(txt) {
  const n = parseFloat(String(txt).replace(',', '.').replace(/[^\d.]/g, ''));
  return Number.isFinite(n) ? n : null;
}

function normalizarNome(txt) {
  const s = String(txt).replace(/\s+/g, ' ').trim();
  return s ? capitalizar(s) : '';
}

function seriesHoje(dia, exercicio) {
  const hoje = hojeChave();
  return cache
    .filter((s) => s.dia_treino === dia && s.exercicio === exercicio && chaveData(s.criado_em) === hoje)
    .sort((a, b) => a.numero_serie - b.numero_serie);
}

function ultimaSerieDe(exercicio) {
  for (let i = cache.length - 1; i >= 0; i--) {
    if (cache[i].exercicio === exercicio) return cache[i];
  }
  return null;
}

function gravarExercicios() { store.gravar(CHAVES.exercicios, exerciciosPorDia); }

/* Feedback háptico: Android usa vibrate; iOS 18+ vibra ao tocar num <input switch>. */
function vibrar(ms = 15) {
  try {
    if (navigator.vibrate) { navigator.vibrate(ms); return; }
    $('#haptic-label').click();
  } catch (e) { /* sem háptico, tudo bem */ }
}


/* =====================================================================
   4a. TELA INÍCIO
   ===================================================================== */

function renderInicio() {
  const hoje = new Date();
  $('#hoje-label').textContent = capitalizar(
    hoje.toLocaleDateString('pt-BR', { weekday: 'long', day: 'numeric', month: 'long' })
  );

  const ultimoDia = store.ler(CHAVES.ultimoDia, null);

  document.querySelectorAll('.dia-btn').forEach((btn) => {
    const dia = btn.dataset.dia;
    const eUltimo = dia === ultimoDia;
    btn.classList.toggle('is-last', eUltimo);
    btn.setAttribute('aria-label', `Treino ${dia}${eUltimo ? ', último escolhido' : ''}`);
    const top = btn.querySelector('.dia-top');
    const badge = top.querySelector('.badge-ultimo');
    if (eUltimo && !badge) top.insertAdjacentHTML('beforeend', '<span class="badge-ultimo">ÚLTIMO</span>');
    if (!eUltimo && badge) badge.remove();
  });

  const info = $('#ultimo-info');
  if (ultimoDia) {
    const ultimaDoDia = [...cache].reverse().find((s) => s.dia_treino === ultimoDia);
    let quando = '';
    if (ultimaDoDia) {
      const k = chaveData(ultimaDoDia.criado_em);
      quando = k === hojeChave() ? ' · hoje' : ' · ' + dataCurta(new Date(ultimaDoDia.criado_em));
    }
    info.innerHTML = 'Último: <strong></strong><span></span>';
    info.querySelector('strong').textContent = `Treino ${ultimoDia}`;
    info.querySelector('span').textContent = quando;
  } else {
    info.textContent = 'Toque no treino de hoje para começar.';
  }
}

function escolherDia(dia) {
  estado.dia = dia;
  store.gravar(CHAVES.ultimoDia, dia);
  vibrar(8);
  irPara('treino');
}


/* =====================================================================
   4b. TELA TREINO (lista de exercícios do dia)
   ===================================================================== */

function resumoExercicio(nome) {
  const hoje = seriesHoje(estado.dia, nome);
  if (hoje.length) {
    return { hoje: hoje.length, texto: 'Hoje: ' + hoje.map((s) => fmtSerie(s.repeticoes, s.carga_kg)).join(' · ') };
  }
  const ultima = ultimaSerieDe(nome);
  if (!ultima) return { hoje: 0, texto: 'Sem registro ainda' };
  const k = chaveData(ultima.criado_em);
  const daquelaVez = cache.filter((s) => s.exercicio === nome && chaveData(s.criado_em) === k);
  const carga = ultima.carga_kg == null ? '' : ` · ${fmtKg(ultima.carga_kg)} kg`;
  return { hoje: 0, texto: `Última vez: ${daquelaVez.length} × ${ultima.repeticoes}${carga}` };
}

function renderTreino() {
  const dia = estado.dia;
  $('#treino-dia').textContent = dia;
  $('#treino-data').textContent = dataCurta(new Date()).toUpperCase();

  const totalHoje = cache.filter((s) => s.dia_treino === dia && chaveData(s.criado_em) === hojeChave()).length;
  $('#treino-resumo').textContent = totalHoje ? `${totalHoje} ${totalHoje === 1 ? 'série' : 'séries'} hoje` : '';

  const lista = $('#ex-list');
  lista.innerHTML = '';
  const nomes = exerciciosPorDia[dia] || [];

  nomes.forEach((nome) => {
    const r = resumoExercicio(nome);
    const li = document.createElement('li');
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'ex-item';
    btn.dataset.nome = nome;
    btn.innerHTML = `
      <span class="ex-info"><span class="ex-title"></span><span class="ex-sub"></span></span>
      ${r.hoje
        ? `<span class="ex-count" aria-label="${r.hoje} séries hoje">${r.hoje}</span>`
        : '<svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><path d="m9 18 6-6-6-6"/></svg>'}`;
    btn.querySelector('.ex-title').textContent = nome;
    btn.querySelector('.ex-sub').textContent = r.texto;
    ligarLongPress(btn, () => removerExercicioDoDia(nome));
    btn.addEventListener('click', () => {
      if (btn.dataset.longpress) { delete btn.dataset.longpress; return; }
      abrirExercicio(nome);
    });
    li.appendChild(btn);
    lista.appendChild(li);
  });

  $('#ex-empty').hidden = nomes.length > 0;
  $('#ex-hint').hidden = nomes.length === 0;
}

function ligarLongPress(el, acao) {
  let timer = null;
  const cancelar = () => { clearTimeout(timer); el.classList.remove('is-holding'); };
  el.addEventListener('pointerdown', () => {
    delete el.dataset.longpress;
    timer = setTimeout(() => {
      el.dataset.longpress = '1';
      el.classList.add('is-holding');
      vibrar(25);
      setTimeout(() => { acao(); el.classList.remove('is-holding'); }, 30);
    }, 600);
  });
  ['pointerup', 'pointerleave', 'pointercancel'].forEach((ev) => el.addEventListener(ev, cancelar));
  el.addEventListener('contextmenu', (e) => e.preventDefault());
}

function removerExercicioDoDia(nome) {
  if (!confirm(`Remover "${nome}" do Treino ${estado.dia}?\nAs séries já registradas continuam no histórico.`)) return;
  exerciciosPorDia[estado.dia] = exerciciosPorDia[estado.dia].filter((n) => n !== nome);
  gravarExercicios();
  renderTreino();
}


/* =====================================================================
   4c. SHEET "NOVO EXERCÍCIO"
   ===================================================================== */

function abrirSheet() {
  $('#sheet-eyebrow').textContent = `ADICIONAR AO TREINO ${estado.dia}`;
  const input = $('#novo-nome');
  input.value = '';
  input.classList.remove('is-invalid');

  // Sugestões: exercícios já usados em outros dias (zero digitação).
  const doDia = new Set((exerciciosPorDia[estado.dia] || []).map((n) => n.toLowerCase()));
  const todos = new Set();
  DIAS.forEach((d) => (exerciciosPorDia[d] || []).forEach((n) => todos.add(n)));
  cache.forEach((s) => todos.add(s.exercicio));
  const sugestoes = [...todos].filter((n) => !doDia.has(n.toLowerCase())).sort((a, b) => a.localeCompare(b, 'pt-BR')).slice(0, 12);

  const box = $('#sugestoes');
  box.innerHTML = '';
  sugestoes.forEach((n) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = n;
    b.addEventListener('click', () => adicionarExercicio(n));
    box.appendChild(b);
  });
  $('#sugestoes-wrap').hidden = sugestoes.length === 0;

  $('#sheet-backdrop').hidden = false;
  $('#sheet-novo').hidden = false;
  ajustarSheetAoTeclado();
  // Sem sugestões, abre direto no teclado; com sugestões, deixa o toque decidir.
  if (!sugestoes.length) input.focus();
}

function fecharSheet() {
  $('#novo-nome').blur();
  $('#sheet-backdrop').hidden = true;
  $('#sheet-novo').hidden = true;
  $('#sheet-novo').style.bottom = '';
}

function adicionarExercicio(nomeBruto) {
  const nome = normalizarNome(nomeBruto);
  const input = $('#novo-nome');
  if (!nome) { input.classList.add('is-invalid'); input.focus(); return; }
  const lista = exerciciosPorDia[estado.dia] || (exerciciosPorDia[estado.dia] = []);
  if (!lista.some((n) => n.toLowerCase() === nome.toLowerCase())) {
    lista.push(nome);
    gravarExercicios();
  }
  vibrar(10);
  fecharSheet();
  renderTreino();
}

/* No iOS o teclado cobre elementos fixos; sobe o sheet junto com ele. */
function ajustarSheetAoTeclado() {
  const vv = window.visualViewport;
  const sheet = $('#sheet-novo');
  if (!vv || sheet.hidden) return;
  const encoberto = window.innerHeight - vv.height - vv.offsetTop;
  sheet.style.bottom = encoberto > 0 ? `${encoberto}px` : '';
}


/* =====================================================================
   4d. TELA EXERCÍCIO (registro da série) — a principal
   ===================================================================== */

let travaRegistro = false;
let timerFeedback = null;
let timerToast = null;

function abrirExercicio(nome) {
  estado.exercicio = nome;
  const ultima = ultimaSerieDe(nome);
  estado.reps = ultima ? ultima.repeticoes : 10;
  estado.carga = ultima ? ultima.carga_kg : null;
  estado.semCarga = ultima ? ultima.carga_kg == null : false;
  vibrar(8);
  irPara('exercicio');
}

function montarGradeReps() {
  const grid = $('#reps-grid');
  for (let v = 1; v <= 20; v++) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'rep-btn';
    b.textContent = v;
    b.dataset.reps = v;
    b.setAttribute('aria-label', `${v} repetições`);
    grid.appendChild(b);
  }
  grid.addEventListener('click', (e) => {
    const b = e.target.closest('.rep-btn');
    if (!b) return;
    estado.reps = Number(b.dataset.reps);
    vibrar(6);
    renderControles();
  });
}

function renderControles() {
  // Reps
  $('#reps-val').textContent = estado.reps;
  document.querySelectorAll('.rep-btn').forEach((b) => {
    b.setAttribute('aria-pressed', String(Number(b.dataset.reps) === estado.reps));
  });

  // Carga
  const input = $('#carga-input');
  if (document.activeElement !== input) {
    input.value = estado.semCarga || estado.carga == null ? '' : fmtKg(estado.carga);
  }
  input.placeholder = estado.semCarga ? '—' : '0';
  $('#carga-row').classList.toggle('is-off', estado.semCarga);
  $('#btn-sem-carga').setAttribute('aria-pressed', String(estado.semCarga));

  // Botão principal
  const feitas = seriesHoje(estado.dia, estado.exercicio);
  const cta = $('#btn-registrar');
  if (!cta.classList.contains('is-done')) {
    $('#cta-main').textContent = `Registrar série ${feitas.length + 1}`;
    $('#cta-sub').textContent = '· ' + fmtSerie(estado.reps, cargaAtual());
  }
}

function cargaAtual() {
  return estado.semCarga ? null : estado.carga;
}

function renderExercicio({ animarNova = false } = {}) {
  $('#ex-nome').textContent = estado.exercicio;
  $('#ex-back-label').textContent = `Treino ${estado.dia}`;

  const feitas = seriesHoje(estado.dia, estado.exercicio);
  $('#serie-num').textContent = feitas.length + 1;

  const pend = idsPendentes();
  const chips = $('#feitas-chips');
  chips.innerHTML = '';
  feitas.forEach((s, i) => {
    const c = document.createElement('span');
    c.className = 'chip' + (animarNova && i === feitas.length - 1 ? ' is-new' : '');
    c.innerHTML = '<span class="chip-n"></span><span></span>';
    c.firstChild.textContent = 'S' + s.numero_serie;
    c.lastChild.textContent = fmtSerie(s.repeticoes, s.carga_kg);
    if (pend.has(s.id)) c.title = 'Aguardando envio';
    chips.appendChild(c);
  });
  chips.scrollLeft = chips.scrollWidth;

  $('#feitas-vazio').hidden = feitas.length > 0;
  $('#btn-desfazer').hidden = feitas.length === 0;
  renderControles();
}

function registrarSerie() {
  if (travaRegistro) return;                 // evita duplo toque acidental
  travaRegistro = true;
  setTimeout(() => { travaRegistro = false; }, 450);

  // Garante que um valor digitado no campo de carga seja usado
  const input = $('#carga-input');
  if (document.activeElement === input) { input.blur(); }

  const feitas = seriesHoje(estado.dia, estado.exercicio);

  // >>> exatamente UMA linha da tabela "series" <<<
  const serie = {
    id: uuid(),
    criado_em: new Date().toISOString(),
    dia_treino: estado.dia,
    exercicio: estado.exercicio,
    numero_serie: feitas.length + 1,
    repeticoes: estado.reps,
    carga_kg: cargaAtual(),
  };

  cache.push(serie);
  gravarCache();
  enfileirarInsert(serie);

  vibrar(18);
  feedbackRegistro(serie);
  renderExercicio({ animarNova: true });
  processarFila();
}

function feedbackRegistro(serie) {
  const cta = $('#btn-registrar');
  cta.classList.add('is-done');
  $('#cta-main').innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>';
  $('#cta-main').append(` Série ${serie.numero_serie} registrada`);
  $('#cta-sub').textContent = '';
  clearTimeout(timerFeedback);
  timerFeedback = setTimeout(() => { cta.classList.remove('is-done'); renderControles(); }, 900);

  const num = $('#serie-num');
  num.classList.remove('bump'); void num.offsetWidth; num.classList.add('bump');

  mostrarToast(`Série ${serie.numero_serie} · ${fmtSerie(serie.repeticoes, serie.carga_kg)}`);
}

function mostrarToast(txt) {
  const t = $('#toast');
  $('#toast-txt').textContent = txt;
  t.hidden = true; void t.offsetWidth; t.hidden = false;
  clearTimeout(timerToast);
  timerToast = setTimeout(() => { t.hidden = true; }, 1500);
}

function desfazerUltima() {
  const feitas = seriesHoje(estado.dia, estado.exercicio);
  const ultima = feitas[feitas.length - 1];
  if (!ultima) return;

  const chip = $('#feitas-chips').lastElementChild;
  const aplicar = () => {
    cache = cache.filter((s) => s.id !== ultima.id);
    gravarCache();
    enfileirarDelete(ultima.id);
    // volta os controles para os valores da série desfeita (fácil corrigir e registrar de novo)
    estado.reps = ultima.repeticoes;
    estado.carga = ultima.carga_kg ?? estado.carga;
    estado.semCarga = ultima.carga_kg == null;
    renderExercicio();
    processarFila();
  };

  vibrar(10);
  $('#toast').hidden = true;
  if (chip) { chip.classList.add('is-leaving'); setTimeout(aplicar, 170); }
  else aplicar();
}

function ligarControlesExercicio() {
  montarGradeReps();

  $('#reps-menos').addEventListener('click', () => { estado.reps = Math.max(1, estado.reps - 1); vibrar(5); renderControles(); });
  $('#reps-mais').addEventListener('click', () => { estado.reps = Math.min(99, estado.reps + 1); vibrar(5); renderControles(); });

  const passo = 2.5;
  $('#carga-menos').addEventListener('click', () => {
    estado.semCarga = false;
    estado.carga = Math.max(0, (estado.carga ?? 0) - passo);
    vibrar(5); renderControles();
  });
  $('#carga-mais').addEventListener('click', () => {
    estado.semCarga = false;
    estado.carga = (estado.carga ?? 0) + passo;
    vibrar(5); renderControles();
  });
  $('#btn-sem-carga').addEventListener('click', () => {
    estado.semCarga = !estado.semCarga;
    vibrar(5); renderControles();
  });

  const input = $('#carga-input');
  input.addEventListener('focus', () => { if (estado.semCarga) { estado.semCarga = false; renderControles(); } input.select(); });
  input.addEventListener('input', () => { estado.carga = lerNumero(input.value); renderControles(); });
  input.addEventListener('blur', () => { estado.carga = lerNumero(input.value); renderControles(); });
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') input.blur(); });

  $('#btn-registrar').addEventListener('click', registrarSerie);
  $('#btn-desfazer').addEventListener('click', desfazerUltima);
}


/* =====================================================================
   4e. TELA HISTÓRICO
   ===================================================================== */

function renderFiltroExercicios() {
  const sel = $('#filtro-ex');
  const nomes = [...new Set(cache.map((s) => s.exercicio))].sort((a, b) => a.localeCompare(b, 'pt-BR'));
  if (estado.filtroEx !== 'todos' && !nomes.includes(estado.filtroEx)) estado.filtroEx = 'todos';
  sel.innerHTML = '';
  sel.append(new Option('Todos os exercícios', 'todos'));
  nomes.forEach((n) => sel.append(new Option(n, n)));
  sel.value = estado.filtroEx;
}

function renderHistorico() {
  renderFiltroExercicios();
  document.querySelectorAll('#filtro-dia button').forEach((b) => {
    b.setAttribute('aria-pressed', String(b.dataset.f === estado.filtroDia));
  });

  const filtradas = cache
    .filter((s) => estado.filtroDia === 'todos' || s.dia_treino === estado.filtroDia)
    .filter((s) => estado.filtroEx === 'todos' || s.exercicio === estado.filtroEx)
    .slice()
    .sort((a, b) => b.criado_em.localeCompare(a.criado_em));

  // data → dia de treino → exercício → séries
  const porData = new Map();
  filtradas.forEach((s) => {
    const k = chaveData(s.criado_em);
    if (!porData.has(k)) porData.set(k, new Map());
    const porDia = porData.get(k);
    if (!porDia.has(s.dia_treino)) porDia.set(s.dia_treino, new Map());
    const porEx = porDia.get(s.dia_treino);
    if (!porEx.has(s.exercicio)) porEx.set(s.exercicio, []);
    porEx.get(s.exercicio).push(s);
  });

  const pend = idsPendentes();
  const ultimoDia = store.ler(CHAVES.ultimoDia, null);
  const frag = document.createDocumentFragment();

  porData.forEach((porDia, k) => {
    const h = document.createElement('h2');
    h.className = 'hist-date';
    h.textContent = rotuloData(k);
    frag.appendChild(h);

    porDia.forEach((porEx, dia) => {
      const total = [...porEx.values()].reduce((acc, arr) => acc + arr.length, 0);
      const grupo = document.createElement('section');
      grupo.className = 'hist-group';
      grupo.innerHTML = `
        <div class="hist-group-head">
          <span class="hist-badge${dia === ultimoDia ? ' is-accent' : ''}" aria-hidden="true"></span>
          <div class="hist-group-title"><strong></strong><span></span></div>
        </div>
        <div class="hist-card"></div>`;
      grupo.querySelector('.hist-badge').textContent = dia;
      grupo.querySelector('strong').textContent = `Treino ${dia}`;
      grupo.querySelector('.hist-group-title span').textContent = `${total} ${total === 1 ? 'série' : 'séries'}`;

      const card = grupo.querySelector('.hist-card');
      // exercícios na ordem em que foram feitos
      [...porEx.entries()].reverse().forEach(([nome, series]) => {
        series.sort((a, b) => a.numero_serie - b.numero_serie);
        const ex = document.createElement('div');
        ex.className = 'hist-ex';
        ex.innerHTML = '<div class="hist-ex-head"><strong></strong><span></span></div><div class="hist-sets"></div>';
        ex.querySelector('strong').textContent = nome;
        ex.querySelector('.hist-ex-head span').textContent = `${series.length} ${series.length === 1 ? 'série' : 'séries'}`;
        const sets = ex.querySelector('.hist-sets');
        series.forEach((s) => {
          const el = document.createElement('span');
          el.className = 'hist-set';
          el.innerHTML = '<span class="chip-n"></span><span></span>';
          el.firstChild.textContent = 'S' + s.numero_serie;
          el.lastChild.textContent = fmtSerie(s.repeticoes, s.carga_kg);
          if (pend.has(s.id)) {
            el.insertAdjacentHTML('beforeend', '<span class="pend" title="Aguardando envio" aria-label="aguardando envio"></span>');
          }
          sets.appendChild(el);
        });
        card.appendChild(ex);
      });
      frag.appendChild(grupo);
    });
  });

  const lista = $('#hist-list');
  lista.innerHTML = '';
  lista.appendChild(frag);

  const vazio = $('#hist-vazio');
  vazio.hidden = filtradas.length > 0;
  if (!filtradas.length) {
    vazio.textContent = cache.length
      ? 'Nenhuma série com esses filtros.'
      : 'Nenhuma série registrada ainda. Bora treinar!';
  }
}

function ligarHistorico() {
  $('#filtro-dia').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    estado.filtroDia = b.dataset.f;
    vibrar(5);
    renderHistorico();
    $('#hist-scroll').scrollTop = 0;
  });
  $('#filtro-ex').addEventListener('change', (e) => {
    estado.filtroEx = e.target.value;
    renderHistorico();
    $('#hist-scroll').scrollTop = 0;
  });
}


/* =====================================================================
   5. NAVEGAÇÃO, EVENTOS GLOBAIS E SERVICE WORKER
   ===================================================================== */

function mostrar(tela) {
  estado.tela = tela;
  document.querySelectorAll('.view').forEach((v) => { v.hidden = v.dataset.view !== tela; v.scrollTop = 0; });
  if (tela === 'inicio') renderInicio();
  if (tela === 'treino') renderTreino();
  if (tela === 'exercicio') renderExercicio();
  if (tela === 'historico') renderHistorico();
  atualizarSync();
}

function irPara(tela) {
  history.pushState({ tela, dia: estado.dia, exercicio: estado.exercicio }, '');
  mostrar(tela);
}

window.addEventListener('popstate', (e) => {
  const s = e.state || { tela: 'inicio' };
  if (!$('#sheet-novo').hidden) fecharSheet();
  if (s.dia) estado.dia = s.dia;
  if (s.exercicio) estado.exercicio = s.exercicio;
  // Telas que dependem de um dia/exercício caem para o início se faltar contexto
  if ((s.tela === 'treino' && !estado.dia) || (s.tela === 'exercicio' && !estado.exercicio)) {
    mostrar('inicio');
  } else {
    mostrar(s.tela);
  }
});

function voltar() {
  if (history.state && history.state.tela !== 'inicio') history.back();
  else mostrar('inicio');
}

function iniciar() {
  // Navegação
  document.querySelectorAll('.dia-btn').forEach((b) => b.addEventListener('click', () => escolherDia(b.dataset.dia)));
  document.querySelectorAll('[data-back]').forEach((b) => b.addEventListener('click', voltar));
  $('#btn-historico').addEventListener('click', () => irPara('historico'));

  // Novo exercício
  $('#btn-novo-ex').addEventListener('click', abrirSheet);
  $('#sheet-cancelar').addEventListener('click', fecharSheet);
  $('#sheet-backdrop').addEventListener('click', fecharSheet);
  $('#sheet-novo').addEventListener('submit', (e) => { e.preventDefault(); adicionarExercicio($('#novo-nome').value); });
  $('#novo-nome').addEventListener('input', (e) => e.target.classList.remove('is-invalid'));
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('#sheet-novo').hidden) fecharSheet(); });
  if (window.visualViewport) {
    visualViewport.addEventListener('resize', ajustarSheetAoTeclado);
    visualViewport.addEventListener('scroll', ajustarSheetAoTeclado);
  }

  ligarControlesExercicio();
  ligarHistorico();

  // Conexão
  window.addEventListener('online', processarFila);
  window.addEventListener('offline', atualizarSync);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      processarFila();
      if (estado.tela === 'inicio') renderInicio(); // a data pode ter mudado
    }
  });

  history.replaceState({ tela: 'inicio' }, '');
  mostrar('inicio');
  processarFila();

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('sw.js').catch((e) => console.warn('SW não registrado', e));
    });
  }
}

iniciar();
