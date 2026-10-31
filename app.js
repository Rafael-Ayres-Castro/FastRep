'use strict';

/* =====================================================================
   FastRep — registro rápido de treino (PWA)
   ---------------------------------------------------------------------
   Estrutura do arquivo:
     1. Camada de dados  → salvarSerie() / removerSerie()  ← trocar pelo Supabase
     2. Fila de sincronização (offline-first)
     3. Estado e utilidades
     4. Telas: início, treino, exercício, histórico, sheet "novo/editar exercício"
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
  removidos:  'serie.exercicios_removidos', // ['A|supino reto'] não voltam ao baixar do servidor
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

/** Lê todas as séries do Supabase, em páginas (o limite por consulta é 1000 linhas). */
async function buscarSeries() {
  const TAMANHO = 1000;
  const todas = [];
  for (let de = 0; ; de += TAMANHO) {
    const { data, error } = await sb.from('series')
      .select('*')
      .order('criado_em')
      .order('id')
      .range(de, de + TAMANHO - 1);
    if (error) throw error;
    todas.push(...data);
    if (data.length < TAMANHO) return todas;
  }
}

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

/** Renomeia um exercício em todas as séries já gravadas. */
async function renomearExercicioNoServidor(de, para) {
  const { error } = await sb.from('series').update({ exercicio: para }).eq('exercicio', de);
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
let revisaoFila = 0;     // muda a cada alteração da fila; detecta mudanças durante um download

function gravarCache() { store.gravar(CHAVES.cache, cache); }
function gravarFila() { revisaoFila++; store.gravar(CHAVES.fila, fila); }

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

function enfileirarRenomear(de, para) {
  fila.push({ op: 'rename', de, para });
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
      else if (op.op === 'rename') await renomearExercicioNoServidor(op.de, op.para);
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

/* Traz o que está no servidor para este aparelho. Só roda com a fila vazia: com envios
   pendentes o servidor ainda não reflete o que foi feito aqui. Com a fila vazia tudo que
   o aparelho registrou já foi enviado, então o servidor é a fonte da verdade: séries
   apagadas lá também somem daqui. */
async function baixarDoServidor() {
  if (!navigator.onLine || fila.length) return;
  const revisao = revisaoFila;
  let doServidor;
  try {
    doServidor = await buscarSeries();
  } catch (e) {
    console.warn('Não foi possível baixar as séries', e);
    return;
  }
  if (fila.length || revisao !== revisaoFila) return;

  const antes = new Set(cache.map((s) => s.exercicio));
  cache = doServidor.map((s) => ({ ...s, criado_em: new Date(s.criado_em).toISOString() }));
  gravarCache();

  // Exercício que só existia por causa de séries (agora apagadas) sai da lista dos treinos.
  const depois = new Set(cache.map((s) => s.exercicio));
  DIAS.forEach((d) => {
    exerciciosPorDia[d] = (exerciciosPorDia[d] || []).filter((n) => !antes.has(n) || depois.has(n));
  });
  incluirExerciciosDoCache();
  atualizarTelaComDados();
}

function incluirExerciciosDoCache() {
  const removidos = new Set(store.ler(CHAVES.removidos, []));
  cache.forEach((s) => {
    const lista = exerciciosPorDia[s.dia_treino] || (exerciciosPorDia[s.dia_treino] = []);
    const nome = s.exercicio.toLowerCase();
    if (removidos.has(`${s.dia_treino}|${nome}`)) return;
    if (!lista.some((n) => n.toLowerCase() === nome)) lista.push(s.exercicio);
  });
  gravarExercicios();
}

function atualizarTelaComDados() {
  if (estado.tela === 'inicio') renderInicio();
  if (estado.tela === 'treino') renderTreino();
  if (estado.tela === 'exercicio') renderExercicio();
  if (estado.tela === 'historico') renderHistorico();
}

async function sincronizar() {
  await processarFila();
  await baixarDoServidor();
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
const NOMES_TREINO = { A: 'Peito Day', B: 'Costas Day', C: 'Leg Day', D: 'Ombro Day' };
const REPS_PADRAO = 12;

const estado = {
  tela: 'inicio',
  dia: null,
  exercicio: null,
  reps: REPS_PADRAO,
  carga: null,      // número ou null (campo vazio)
  semCarga: false,
  filtroDia: 'todos',
  filtroEx: 'todos',
  editando: null,   // nome do exercício aberto no sheet de edição
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

function partesData(chave) {
  const [a, m, d] = chave.split('-').map(Number);
  const data = new Date(a, m - 1, d);
  const ontem = new Date(); ontem.setDate(ontem.getDate() - 1);
  let titulo = capitalizar(data.toLocaleDateString('pt-BR', { weekday: 'long' }));
  if (chave === hojeChave()) titulo = 'Hoje';
  else if (chave === chaveData(ontem)) titulo = 'Ontem';
  return { dia: d, titulo, sub: data.toLocaleDateString('pt-BR', { month: 'long', year: 'numeric' }) };
}

function fmtKg(n) {
  return Number(n).toLocaleString('pt-BR', { maximumFractionDigits: 2 });
}

function fmtSerie(reps, carga) {
  return carga == null ? `${reps} reps` : `${reps} × ${fmtKg(carga)} kg`;
}

function fmtVolume(kg) {
  if (kg >= 1000) return `${(kg / 1000).toLocaleString('pt-BR', { maximumFractionDigits: 1 })} t`;
  return `${fmtKg(Math.round(kg))} kg`;
}

function volumeDe(series) {
  return series.reduce((acc, s) => acc + (s.carga_kg == null ? 0 : s.repeticoes * s.carga_kg), 0);
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

/* Séries idênticas (mesmas reps e carga) viram um único grupo, na ordem da primeira. */
function chaveGrupo(s) { return `${s.repeticoes}|${s.carga_kg ?? ''}`; }

function agruparSeries(series) {
  const grupos = new Map();
  series.forEach((s) => {
    const k = chaveGrupo(s);
    if (!grupos.has(k)) grupos.set(k, []);
    grupos.get(k).push(s);
  });
  return [...grupos.values()];
}

function criarChipSerie(grupo, classe) {
  const s = grupo[0];
  const el = document.createElement('span');
  el.className = classe;
  el.dataset.chave = chaveGrupo(s);
  el.innerHTML = '<span></span>';
  el.lastChild.textContent = fmtSerie(s.repeticoes, s.carga_kg);
  if (grupo.length > 1) {
    el.setAttribute('aria-label', `${grupo.length} séries de ${fmtSerie(s.repeticoes, s.carga_kg)}`);
    el.insertAdjacentHTML('beforeend', '<span class="chip-x" aria-hidden="true"></span>');
    el.lastChild.textContent = `${grupo.length}x`;
  } else {
    el.insertAdjacentHTML('afterbegin', '<span class="chip-n"></span>');
    el.firstChild.textContent = 'S' + s.numero_serie;
  }
  return el;
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

  // Último treino = o da série registrada mais recentemente (só abrir um treino não conta).
  const ultimaSerie = cache[cache.length - 1];
  const ultimoDia = ultimaSerie ? ultimaSerie.dia_treino : null;

  document.querySelectorAll('.dia-btn').forEach((btn) => {
    const dia = btn.dataset.dia;
    const eUltimo = dia === ultimoDia;
    btn.classList.toggle('is-last', eUltimo);
    btn.setAttribute('aria-label', `${NOMES_TREINO[dia]}${eUltimo ? ', último escolhido' : ''}`);
    const top = btn.querySelector('.dia-top');
    const badge = top.querySelector('.badge-ultimo');
    if (eUltimo && !badge) top.insertAdjacentHTML('beforeend', '<span class="badge-ultimo">ÚLTIMO</span>');
    if (!eUltimo && badge) badge.remove();
  });

  const info = $('#ultimo-info');
  if (ultimoDia) {
    const k = chaveData(ultimaSerie.criado_em);
    const quando = k === hojeChave() ? ' · hoje' : ' · ' + dataCurta(new Date(ultimaSerie.criado_em));
    info.innerHTML = 'Último: <strong></strong><span></span>';
    info.querySelector('strong').textContent = NOMES_TREINO[ultimoDia];
    info.querySelector('span').textContent = quando;
  } else {
    info.textContent = 'Toque no treino de hoje para começar.';
  }
}

function escolherDia(dia) {
  estado.dia = dia;
  vibrar(8);
  irPara('treino');
}


/* =====================================================================
   4b. TELA TREINO (lista de exercícios do dia)
   ===================================================================== */

function resumoExercicio(nome) {
  const hoje = seriesHoje(estado.dia, nome);
  if (hoje.length) {
    return { hoje: hoje.length, grupos: agruparSeries(hoje) };
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
  $('#treino-dia').textContent = NOMES_TREINO[dia];
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
    const sub = btn.querySelector('.ex-sub');
    if (r.grupos) {
      sub.className = 'ex-sets';
      r.grupos.forEach((g) => sub.appendChild(criarChipSerie(g, 'hist-set')));
    } else {
      sub.textContent = r.texto;
    }
    ligarLongPress(btn, () => abrirEdicao(nome));
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
  if (!confirm(`Remover "${nome}" do ${NOMES_TREINO[estado.dia]}?\nAs séries já registradas continuam no histórico.`)) return;
  exerciciosPorDia[estado.dia] = exerciciosPorDia[estado.dia].filter((n) => n !== nome);
  gravarExercicios();
  store.gravar(CHAVES.removidos, [...store.ler(CHAVES.removidos, []), `${estado.dia}|${nome.toLowerCase()}`]);
  fecharSheet();
  renderTreino();
}


/* =====================================================================
   4c. SHEET "NOVO / EDITAR EXERCÍCIO"
   ===================================================================== */

function limparErroNome() {
  $('#novo-nome').classList.remove('is-invalid');
  $('#novo-erro').hidden = true;
}

function abrirSheet() {
  estado.editando = null;
  $('#sheet-eyebrow').textContent = `ADICIONAR · ${NOMES_TREINO[estado.dia].toUpperCase()}`;
  $('#sheet-title').textContent = 'Novo exercício';
  $('#sheet-salvar').textContent = 'Adicionar';
  $('#sheet-remover').hidden = true;
  const input = $('#novo-nome');
  input.value = '';
  limparErroNome();

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

function abrirEdicao(nome) {
  estado.editando = nome;
  $('#sheet-eyebrow').textContent = `EDITAR · ${NOMES_TREINO[estado.dia].toUpperCase()}`;
  $('#sheet-title').textContent = 'Renomear exercício';
  $('#sheet-salvar').textContent = 'Salvar';
  $('#sheet-remover').hidden = false;
  $('#sugestoes-wrap').hidden = true;
  $('#novo-nome').value = nome;
  limparErroNome();
  $('#sheet-backdrop').hidden = false;
  $('#sheet-novo').hidden = false;
  ajustarSheetAoTeclado();
}

/* O nome é a identidade do exercício: renomeia em todos os dias, no cache e no servidor. */
function salvarEdicao(nomeBruto) {
  const de = estado.editando;
  const para = normalizarNome(nomeBruto);
  const input = $('#novo-nome');
  if (!para) { input.classList.add('is-invalid'); input.focus(); return; }
  if (para === de) { fecharSheet(); return; }

  const existentes = new Set(cache.map((s) => s.exercicio));
  DIAS.forEach((d) => (exerciciosPorDia[d] || []).forEach((n) => existentes.add(n)));
  existentes.delete(de);
  if ([...existentes].some((n) => n.toLowerCase() === para.toLowerCase())) {
    input.classList.add('is-invalid');
    $('#novo-erro').textContent = 'Já existe um exercício com esse nome.';
    $('#novo-erro').hidden = false;
    return;
  }

  DIAS.forEach((d) => {
    exerciciosPorDia[d] = (exerciciosPorDia[d] || []).map((n) => (n === de ? para : n));
  });
  gravarExercicios();
  cache.forEach((s) => { if (s.exercicio === de) s.exercicio = para; });
  gravarCache();
  enfileirarRenomear(de, para);
  if (estado.filtroEx === de) estado.filtroEx = para;
  if (estado.exercicio === de) estado.exercicio = para;

  vibrar(10);
  fecharSheet();
  renderTreino();
  processarFila();
}

function fecharSheet() {
  estado.editando = null;
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
  const chaveRemovido = `${estado.dia}|${nome.toLowerCase()}`;
  store.gravar(CHAVES.removidos, store.ler(CHAVES.removidos, []).filter((k) => k !== chaveRemovido));
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
  estado.reps = ultima ? ultima.repeticoes : REPS_PADRAO;
  estado.carga = ultima ? ultima.carga_kg : null;
  estado.semCarga = ultima ? ultima.carga_kg == null : false;
  vibrar(8);
  irPara('exercicio');
}

function montarGradeReps() {
  const grid = $('#reps-grid');
  for (let v = 10; v <= 15; v++) {
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
  $('#ex-back-label').textContent = NOMES_TREINO[estado.dia];

  const feitas = seriesHoje(estado.dia, estado.exercicio);
  $('#serie-num').textContent = feitas.length + 1;

  const pend = idsPendentes();
  const chips = $('#feitas-chips');
  chips.innerHTML = '';
  const chaveNova = animarNova && feitas.length ? chaveGrupo(feitas[feitas.length - 1]) : null;
  let chipNovo = null;
  agruparSeries(feitas).forEach((grupo) => {
    const c = criarChipSerie(grupo, 'chip');
    if (c.dataset.chave === chaveNova) { c.classList.add('is-new'); chipNovo = c; }
    if (grupo.some((s) => pend.has(s.id))) c.title = 'Aguardando envio';
    chips.appendChild(c);
  });
  chips.scrollLeft = chipNovo ? chipNovo.offsetLeft - 16 : chips.scrollWidth;

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

  // O chip só sai da tela se esta era a única série do grupo; senão, só o "2x" diminui.
  const k = chaveGrupo(ultima);
  const unica = feitas.filter((s) => chaveGrupo(s) === k).length === 1;
  const chip = unica ? $('#feitas-chips').querySelector(`[data-chave="${k}"]`) : null;
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

/* Compara a maior carga de cada dia com o dia anterior do mesmo exercício. */
function evolucaoExercicios() {
  const porEx = new Map();
  cache.forEach((s) => {
    if (s.carga_kg == null) return;
    if (!porEx.has(s.exercicio)) porEx.set(s.exercicio, new Map());
    const porData = porEx.get(s.exercicio);
    const k = chaveData(s.criado_em);
    porData.set(k, Math.max(porData.get(k) ?? 0, s.carga_kg));
  });

  const evolucao = new Map();
  porEx.forEach((porData, nome) => {
    let anterior = null;
    let melhor = null;
    [...porData.keys()].sort().forEach((k) => {
      const max = porData.get(k);
      if (anterior != null) evolucao.set(`${nome}|${k}`, { delta: max - anterior, recorde: max > melhor });
      anterior = max;
      melhor = Math.max(melhor ?? 0, max);
    });
  });
  return evolucao;
}

function renderResumoHistorico(filtradas) {
  const box = $('#hist-resumo');
  box.innerHTML = '';
  if (!filtradas.length) return;

  const treinos = new Set(filtradas.map((s) => `${chaveData(s.criado_em)}|${s.dia_treino}`)).size;
  const stats = [
    [treinos, treinos === 1 ? 'treino' : 'treinos'],
    [filtradas.length, filtradas.length === 1 ? 'série' : 'séries'],
    [fmtVolume(volumeDe(filtradas)), 'volume'],
  ];
  const tiles = document.createElement('div');
  tiles.className = 'hist-stats';
  stats.forEach(([valor, rotulo]) => {
    const t = document.createElement('div');
    t.className = 'hist-stat';
    t.innerHTML = '<strong></strong><span></span>';
    t.firstChild.textContent = valor;
    t.lastChild.textContent = rotulo;
    tiles.appendChild(t);
  });
  box.appendChild(tiles);

  // Semana atual, de segunda a domingo: em quais dias houve treino
  const semana = document.createElement('div');
  semana.className = 'hist-semana';
  semana.setAttribute('role', 'img');
  const rotulosAria = [];
  const hojeNaSemana = (new Date().getDay() + 6) % 7;   // segunda = 0 ... domingo = 6
  for (let i = 0; i < 7; i++) {
    const d = new Date(); d.setDate(d.getDate() - hojeNaSemana + i);
    const k = chaveData(d);
    const dias = [...new Set(filtradas.filter((s) => chaveData(s.criado_em) === k).map((s) => s.dia_treino))].sort();
    if (dias.length) rotulosAria.push(`${dataCurta(d)}: ${dias.map((x) => NOMES_TREINO[x]).join(' e ')}`);
    const c = document.createElement('div');
    c.className = 'hist-semana-dia' + (i === hojeNaSemana ? ' is-hoje' : '');
    c.innerHTML = '<span></span><b></b>';
    c.firstChild.textContent = 'STQQSSD'[i];
    c.lastChild.textContent = dias.join('');
    c.lastChild.classList.toggle('is-on', dias.length > 0);
    semana.appendChild(c);
  }
  semana.setAttribute('aria-label', rotulosAria.length
    ? `Esta semana. ${rotulosAria.join('. ')}.`
    : 'Nenhum treino nesta semana.');
  box.appendChild(semana);
}

function fmtDuracao(series) {
  const tempos = series.map((s) => new Date(s.criado_em).getTime());
  const min = Math.round((Math.max(...tempos) - Math.min(...tempos)) / 60000);
  if (min < 1) return '';
  return min < 60 ? `${min} min` : `${Math.floor(min / 60)}h${pad2(min % 60)}`;
}

function criarTagEvolucao(ev) {
  if (!ev || (!ev.delta && !ev.recorde)) return null;
  const tag = document.createElement('span');
  const valor = `${fmtKg(Math.abs(ev.delta))} kg`;
  if (ev.recorde) {
    tag.className = 'hist-tag is-pr';
    tag.textContent = `PR +${valor}`;
    tag.setAttribute('aria-label', `Recorde: mais ${valor}`);
  } else if (ev.delta > 0) {
    tag.className = 'hist-tag is-up';
    tag.textContent = `▲ ${valor}`;
    tag.setAttribute('aria-label', `Mais ${valor} que a vez anterior`);
  } else {
    tag.className = 'hist-tag';
    tag.textContent = `▼ ${valor}`;
    tag.setAttribute('aria-label', `Menos ${valor} que a vez anterior`);
  }
  return tag;
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

  renderResumoHistorico(filtradas);

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
  const evolucao = evolucaoExercicios();
  const frag = document.createDocumentFragment();

  porData.forEach((porDia, k) => {
    const partes = partesData(k);
    const h = document.createElement('h2');
    h.className = 'hist-date';
    h.innerHTML = '<span class="hist-date-num"></span><span class="hist-date-txt"><strong></strong><span></span></span>';
    h.querySelector('.hist-date-num').textContent = partes.dia;
    h.querySelector('strong').textContent = partes.titulo;
    h.querySelector('.hist-date-txt span').textContent = partes.sub;
    frag.appendChild(h);

    porDia.forEach((porEx, dia) => {
      const doTreino = [...porEx.values()].flat();
      const meta = [`${doTreino.length} ${doTreino.length === 1 ? 'série' : 'séries'}`];
      const volume = volumeDe(doTreino);
      if (volume > 0) meta.push(fmtVolume(volume));
      if (estado.filtroEx === 'todos') {
        const duracao = fmtDuracao(doTreino);
        if (duracao) meta.push(duracao);
      }

      const grupo = document.createElement('section');
      grupo.className = 'hist-group';
      grupo.innerHTML = `
        <div class="hist-group-head">
          <span class="hist-badge" aria-hidden="true"></span>
          <div class="hist-group-title"><strong></strong><span></span></div>
        </div>`;
      grupo.querySelector('.hist-badge').textContent = dia;
      grupo.querySelector('strong').textContent = NOMES_TREINO[dia];
      grupo.querySelector('.hist-group-title span').textContent = meta.join(' · ');

      // exercícios na ordem em que foram feitos
      [...porEx.entries()].reverse().forEach(([nome, series]) => {
        series.sort((a, b) => a.numero_serie - b.numero_serie);
        const ex = document.createElement('div');
        ex.className = 'hist-ex';
        ex.innerHTML = '<div class="hist-ex-head"><strong></strong></div><div class="hist-sets"></div>';
        ex.querySelector('strong').textContent = nome;
        const tag = criarTagEvolucao(evolucao.get(`${nome}|${k}`));
        if (tag) ex.querySelector('.hist-ex-head').appendChild(tag);
        const sets = ex.querySelector('.hist-sets');
        agruparSeries(series).forEach((g) => {
          const el = criarChipSerie(g, 'hist-set');
          if (g.some((s) => pend.has(s.id))) {
            el.insertAdjacentHTML('beforeend', '<span class="pend" title="Aguardando envio" aria-label="aguardando envio"></span>');
          }
          sets.appendChild(el);
        });
        grupo.appendChild(ex);
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
  $('#sheet-remover').addEventListener('click', () => removerExercicioDoDia(estado.editando));
  $('#sheet-novo').addEventListener('submit', (e) => {
    e.preventDefault();
    const nome = $('#novo-nome').value;
    if (estado.editando) salvarEdicao(nome);
    else adicionarExercicio(nome);
  });
  $('#novo-nome').addEventListener('input', limparErroNome);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('#sheet-novo').hidden) fecharSheet(); });
  if (window.visualViewport) {
    visualViewport.addEventListener('resize', ajustarSheetAoTeclado);
    visualViewport.addEventListener('scroll', ajustarSheetAoTeclado);
  }

  ligarControlesExercicio();
  ligarHistorico();

  // Conexão
  window.addEventListener('online', sincronizar);
  window.addEventListener('offline', atualizarSync);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      sincronizar();
      if ('serviceWorker' in navigator) navigator.serviceWorker.getRegistration().then((r) => r && r.update()).catch(() => {});
      if (estado.tela === 'inicio') renderInicio(); // a data pode ter mudado
    }
  });

  history.replaceState({ tela: 'inicio' }, '');
  mostrar('inicio');
  sincronizar();

  if ('serviceWorker' in navigator) {
    // Versão nova assumiu o controle: recarrega para usar o código novo (não na primeira instalação).
    if (navigator.serviceWorker.controller) {
      let recarregando = false;
      navigator.serviceWorker.addEventListener('controllerchange', () => {
        if (recarregando) return;
        recarregando = true;
        location.reload();
      });
    }
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('sw.js').catch((e) => console.warn('SW não registrado', e));
    });
  }
}

iniciar();
