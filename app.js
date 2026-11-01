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
  padroes:    'serie.padroes',         // { 'supino reto': { reps: 12, carga: 40 } }
  migrados:   'serie.exercicios_migrados', // este aparelho já enviou sua lista à tabela "exercicios"
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

  const r = await sb.from('exercicios').update({ nome: para }).eq('nome', de);
  if (r.error && r.error.code === '23505') {
    // Outro aparelho já criou o novo nome: fica só ele.
    const { error: erroApagar } = await sb.from('exercicios').delete().eq('nome', de);
    if (erroApagar) throw erroApagar;
  } else if (r.error && !tabelaAusente(r.error)) {
    throw r.error;
  }
}

/* Sem a tabela "exercicios" o app segue funcionando só com a lista local. */
function tabelaAusente(error) {
  return error.code === 'PGRST205' || error.code === '42P01';
}

async function buscarExercicios() {
  const { data, error } = await sb.from('exercicios').select('*').order('criado_em').order('nome');
  if (error && tabelaAusente(error)) return null;
  if (error) throw error;
  return data;
}

async function salvarExercicio(linha) {
  const { error } = await sb.from('exercicios').upsert(linha, { onConflict: 'nome' });
  if (error && !tabelaAusente(error)) throw error;
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

/* A linha é montada do estado local; criado_em só vai na migração (preserva a ordem). */
function enfileirarExercicio(nome, criadoEm) {
  const padrao = padraoDe(nome);
  const linha = {
    nome,
    dias: DIAS.filter((d) => (exerciciosPorDia[d] || []).includes(nome)),
    reps_padrao: padrao.reps,
    carga_padrao: padrao.carga,
  };
  if (criadoEm) linha.criado_em = criadoEm;
  fila.push({ op: 'exercicio', linha });
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
      else if (op.op === 'exercicio') await salvarExercicio(op.linha);
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
    if (estado.tela === 'graficos') renderGraficos();
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
  let exercicios;
  try {
    doServidor = await buscarSeries();
    exercicios = await buscarExercicios();
  } catch (e) {
    console.warn('Não foi possível baixar as séries', e);
    return;
  }
  if (fila.length || revisao !== revisaoFila) return;

  const antes = new Set(cache.map((s) => s.exercicio));
  cache = doServidor.map((s) => ({ ...s, criado_em: new Date(s.criado_em).toISOString() }));
  gravarCache();

  if (exercicios) {
    aplicarExercicios(exercicios);
  } else {
    // Exercício que só existia por causa de séries (agora apagadas) sai da lista dos treinos.
    const depois = new Set(cache.map((s) => s.exercicio));
    DIAS.forEach((d) => {
      exerciciosPorDia[d] = (exerciciosPorDia[d] || []).filter((n) => !antes.has(n) || depois.has(n));
    });
    incluirExerciciosDoCache();
  }
  atualizarTelaComDados();
  if (fila.length) processarFila();
}

/* A tabela "exercicios" é a fonte da verdade da lista de cada treino e dos padrões.
   Na primeira vez, cada aparelho soma a ela o que tinha guardado localmente. */
function aplicarExercicios(linhas) {
  const mapa = new Map(linhas.map((l) => [l.nome.toLowerCase(), {
    nome: l.nome,
    dias: [...l.dias],
    reps: l.reps_padrao,
    carga: l.carga_padrao == null ? null : Number(l.carga_padrao),
  }]));
  const existentes = new Set(mapa.keys());
  const alterados = new Set();

  if (!store.ler(CHAVES.migrados, false)) {
    const removidos = new Set(store.ler(CHAVES.removidos, []));
    const juntar = (nome, dia) => {
      const k = nome.toLowerCase();
      if (!mapa.has(k)) { mapa.set(k, { nome, dias: [], reps: null, carga: null }); alterados.add(k); }
      const e = mapa.get(k);
      if (!e.dias.includes(dia)) { e.dias.push(dia); alterados.add(k); }
    };
    DIAS.forEach((d) => (exerciciosPorDia[d] || []).forEach((n) => juntar(n, d)));
    // Tabela vazia: é a primeira migração, então recupera também o que só aparece nas séries.
    if (!linhas.length) cache.forEach((s) => juntar(s.exercicio, s.dia_treino));

    Object.entries(store.ler(CHAVES.padroes, {})).forEach(([k, p]) => {
      const e = mapa.get(k);
      if (!e) return;
      if (e.reps == null && p.reps != null) { e.reps = p.reps; alterados.add(k); }
      if (e.carga == null && p.carga != null) { e.carga = p.carga; alterados.add(k); }
    });
    mapa.forEach((e, k) => {
      const dias = e.dias.filter((d) => !removidos.has(`${d}|${k}`));
      if (dias.length !== e.dias.length) { e.dias = dias; alterados.add(k); }
    });
    store.gravar(CHAVES.migrados, true);
  }

  const todos = [...mapa.values()];
  DIAS.forEach((d) => {
    exerciciosPorDia[d] = todos.filter((e) => e.dias.includes(d)).map((e) => e.nome);
  });
  gravarExercicios();

  const padroes = {};
  mapa.forEach((e, k) => {
    if (e.reps != null || e.carga != null) padroes[k] = { reps: e.reps, carga: e.carga };
  });
  store.gravar(CHAVES.padroes, padroes);

  const agora = Date.now();
  [...alterados].forEach((k, i) => {
    enfileirarExercicio(mapa.get(k).nome, existentes.has(k) ? null : new Date(agora + i).toISOString());
  });
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
  if (estado.tela === 'graficos') renderGraficos();
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
    texto = `Offline · ${n}`;
    aria = `Sem conexão. ${n} ${n === 1 ? 'série será enviada' : 'séries serão enviadas'} depois.`;
  } else if (!navigator.onLine) {
    classe = 'is-offline';
    texto = 'Offline';
    aria = 'Sem conexão. Novos registros serão enviados depois.';
  } else if (sincronizando) {
    classe = 'is-sending';
    texto = 'Enviando…';
    aria = 'Enviando registros';
  } else if (erroSync && n > 0) {
    classe = 'is-error';
    texto = 'Erro ao enviar';
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
  diaSel: null,     // dia escolhido nas faixas de semana ('2026-10-31'); null = hoje no treino, todos no histórico
  semanaDesl: 0,    // quantas semanas a faixa está deslocada em relação à atual
  diaVerEx: null,   // dia mostrado em "Feitas" na tela de registro; null = hoje
  grafPeriodo: '30',
  grafTreino: 'todos',
  grafEx: null,
  grafMetrica: 'rm',
  grafGeral: 'series',
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

function parseChave(chave) {
  const [a, m, d] = chave.split('-').map(Number);
  return new Date(a, m - 1, d);
}

/* "28 out" */
function dataCurtinha(chave) {
  const d = parseChave(chave);
  return `${d.getDate()} ${d.toLocaleDateString('pt-BR', { month: 'short' }).replace('.', '')}`;
}

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
  if (kg >= 10000) return `${(kg / 1000).toLocaleString('pt-BR', { maximumFractionDigits: 1 })} t`;
  return `${Math.round(kg).toLocaleString('pt-BR')} kg`;
}

function lerNumero(txt) {
  const n = parseFloat(String(txt).replace(',', '.').replace(/[^\d.]/g, ''));
  return Number.isFinite(n) ? n : null;
}

function normalizarNome(txt) {
  const s = String(txt).replace(/\s+/g, ' ').trim();
  return s ? capitalizar(s) : '';
}

function seriesDoDia(dia, exercicio, chave) {
  return cache
    .filter((s) => s.dia_treino === dia && s.exercicio === exercicio && chaveData(s.criado_em) === chave)
    .sort((a, b) => a.numero_serie - b.numero_serie);
}

function seriesHoje(dia, exercicio) {
  return seriesDoDia(dia, exercicio, hojeChave());
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

function semanaDeslDe(chave) {
  const segunda = (d) => { const x = new Date(d); x.setDate(x.getDate() - (x.getDay() + 6) % 7); x.setHours(12, 0, 0, 0); return x; };
  return Math.round((segunda(parseChave(chave)) - segunda(new Date())) / (7 * 86400000));
}

/* Tocar de novo no dia já escolhido desfaz a escolha. */
function selecionarDia(chave, aoMudar, manter = false) {
  estado.diaSel = !manter && estado.diaSel === chave ? null : chave;
  estado.semanaDesl = estado.diaSel ? semanaDeslDe(estado.diaSel) : estado.semanaDesl;
  vibrar(5);
  aoMudar();
}

/* Os sete dias, de segunda a domingo, da semana em que a faixa está. */
function diasDaSemana() {
  const inicio = new Date();
  inicio.setDate(inicio.getDate() - (inicio.getDay() + 6) % 7 + estado.semanaDesl * 7);
  return Array.from({ length: 7 }, (_, i) => { const d = new Date(inicio); d.setDate(d.getDate() + i); return d; });
}

const periodoDaSemana = (dias) => `${dataCurtinha(chaveData(dias[0]))} – ${dataCurtinha(chaveData(dias[6]))}`;

function criarSetasSemana(aoMudar) {
  const seta = (rotulo, caminho, delta, desativada) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'nav-dia';
    b.setAttribute('aria-label', rotulo);
    b.disabled = desativada;
    b.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${caminho}"/></svg>`;
    b.addEventListener('click', () => { estado.semanaDesl += delta; vibrar(5); aoMudar(); });
    return b;
  };
  return [seta('Semana anterior', 'm15 18-6-6 6-6', -1, false), seta('Próxima semana', 'm9 18 6-6-6-6', 1, estado.semanaDesl >= 0)];
}

/* Seletor de dia: semana de segunda a domingo, setas para trocar de semana e calendário
   para ir a qualquer data. Dia treinado ganha a cor do treino (branco se houve mais de um). */
function criarSeletorDia(series, aoMudar, { hojePadrao = false } = {}) {
  const hoje = hojeChave();
  const dias = diasDaSemana();

  const box = document.createElement('div');
  box.className = 'seletor-dia';
  const head = document.createElement('div');
  head.className = 'seletor-head';
  const meio = document.createElement(estado.diaSel ? 'button' : 'span');
  meio.className = 'seletor-periodo';
  if (estado.diaSel) {
    meio.type = 'button';
    meio.classList.add('is-sel');
    meio.textContent = `${capitalizar(dataCurta(parseChave(estado.diaSel)))} ×`;
    meio.setAttribute('aria-label', hojePadrao ? 'Voltar para hoje' : 'Ver todos os dias');
    meio.addEventListener('click', () => { estado.diaSel = null; estado.semanaDesl = 0; vibrar(5); aoMudar(); });
  } else {
    meio.textContent = periodoDaSemana(dias);
  }
  const cal = document.createElement('label');
  cal.className = 'nav-dia seletor-cal';
  cal.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="4" y="5" width="16" height="15" rx="3"/><path d="M4 10h16M8 3v4M16 3v4"/></svg><input type="date" aria-label="Escolher uma data">';
  const campo = cal.querySelector('input');
  campo.max = hoje;
  campo.value = estado.diaSel || hoje;
  campo.addEventListener('click', () => { try { campo.showPicker(); } catch (e) { /* o toque já abre o seletor */ } });
  campo.addEventListener('change', () => { if (campo.value && campo.value <= hoje) selecionarDia(campo.value, aoMudar, true); });
  const [anterior, proxima] = criarSetasSemana(aoMudar);
  head.append(anterior, meio, proxima, cal);
  box.appendChild(head);

  const semana = document.createElement('div');
  semana.className = 'hist-semana';
  semana.setAttribute('role', 'group');
  semana.setAttribute('aria-label', 'Escolher o dia');
  dias.forEach((d, i) => {
    const k = chaveData(d);
    const treinos = [...new Set(series.filter((s) => chaveData(s.criado_em) === k).map((s) => s.dia_treino))].sort();
    const sel = estado.diaSel ? estado.diaSel === k : hojePadrao && k === hoje;
    const c = document.createElement('button');
    c.type = 'button';
    c.className = 'hist-semana-dia' + (k === hoje ? ' is-hoje' : '') + (sel ? ' is-sel' : '');
    c.disabled = k > hoje;
    c.setAttribute('aria-pressed', String(sel));
    c.setAttribute('aria-label', `${dataCurta(d)}${treinos.length ? `: ${treinos.map((x) => NOMES_TREINO[x]).join(' e ')}` : ''}`);
    c.innerHTML = '<b></b><span></span>';
    c.firstChild.textContent = d.getDate();
    c.firstChild.classList.toggle('is-on', treinos.length > 0);
    if (treinos.length === 1) c.firstChild.dataset.dia = treinos[0];
    c.lastChild.textContent = ['Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb', 'Dom'][i];
    c.addEventListener('click', () => selecionarDia(k, aoMudar));
    semana.appendChild(c);
  });
  box.appendChild(semana);
  return box;
}

function gravarExercicios() { store.gravar(CHAVES.exercicios, exerciciosPorDia); }

function padraoDe(nome) {
  return store.ler(CHAVES.padroes, {})[nome.toLowerCase()] || { reps: null, carga: null };
}

function gravarPadrao(nome, padrao) {
  const padroes = store.ler(CHAVES.padroes, {});
  if (padrao.reps == null && padrao.carga == null) delete padroes[nome.toLowerCase()];
  else padroes[nome.toLowerCase()] = padrao;
  store.gravar(CHAVES.padroes, padroes);
}

function lerPadraoDoSheet() {
  const reps = lerNumero($('#padrao-reps').value);
  return {
    reps: reps == null || reps < 1 ? null : Math.min(99, Math.round(reps)),
    carga: lerNumero($('#padrao-carga').value),
  };
}

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

  renderGraficoSemana();
}

/* Séries por dia nos últimos 7 dias: laranja nos dias de pico, balão com o total de hoje. */
function renderGraficoSemana() {
  const dias = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date(); d.setDate(d.getDate() - i);
    const k = chaveData(d);
    dias.push({ d, n: cache.filter((s) => chaveData(s.criado_em) === k).length, hoje: i === 0 });
  }
  const max = Math.max(...dias.map((x) => x.n));
  const passo = max <= 8 ? 2 : max <= 20 ? 5 : max <= 40 ? 10 : 20;
  const topo = Math.max(4, Math.ceil(max / passo) * passo);

  const box = $('#semana-grafico');
  box.innerHTML = `
    <h2 class="grafico-titulo">Séries por dia</h2>
    <div class="grafico-plot"></div>
    <div class="grafico-dias" aria-hidden="true"></div>`;
  const plot = box.querySelector('.grafico-plot');
  const rotulos = box.querySelector('.grafico-dias');
  plot.setAttribute('role', 'group');
  plot.setAttribute('aria-label', 'Séries nos últimos 7 dias. Toque em um dia para ver o histórico dele.');

  for (let v = 0; v <= topo; v += passo) {
    const linha = document.createElement('span');
    linha.className = 'grafico-linha';
    linha.style.bottom = `${(v / topo) * 100}%`;
    linha.textContent = v;
    plot.appendChild(linha);
  }
  dias.forEach(({ d, n, hoje }) => {
    const col = document.createElement('button');
    col.type = 'button';
    col.className = 'grafico-col';
    col.setAttribute('aria-label', `${dataCurta(d)}: ${n} ${n === 1 ? 'série' : 'séries'}`);
    col.addEventListener('click', () => {
      vibrar(5);
      estado.diaSel = chaveData(d);
      estado.semanaDesl = semanaDeslDe(estado.diaSel);
      irPara('historico');
    });
    const barra = document.createElement('div');
    barra.className = 'grafico-barra' + (n > 0 && n === max ? ' is-pico' : '') + (n === 0 ? ' is-vazia' : '');
    barra.style.height = n ? `${(n / topo) * 100}%` : '';
    if (hoje && n > 0) {
      const dica = document.createElement('span');
      dica.className = 'grafico-dica';
      dica.textContent = n;
      barra.appendChild(dica);
    }
    col.appendChild(barra);
    plot.appendChild(col);

    const r = document.createElement('span');
    r.textContent = capitalizar(d.toLocaleDateString('pt-BR', { weekday: 'short' }).replace('.', ''));
    r.classList.toggle('is-hoje', hoje);
    rotulos.appendChild(r);
  });
}

function escolherDia(dia) {
  estado.dia = dia;
  vibrar(8);
  irPara('treino');
}


/* =====================================================================
   4b. TELA TREINO (lista de exercícios do dia)
   ===================================================================== */

const chaveTreino = () => estado.diaSel ?? hojeChave();

function resumoExercicio(nome) {
  const chave = chaveTreino();
  const doDia = seriesDoDia(estado.dia, nome, chave);
  if (doDia.length) {
    return { hoje: doDia.length, grupos: agruparSeries(doDia) };
  }
  if (chave !== hojeChave()) return { hoje: 0, texto: 'Sem registro nesse dia' };
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
  const chave = chaveTreino();
  const eHoje = chave === hojeChave();
  $('#treino-data').textContent = capitalizar(dataCurta(parseChave(chave)));

  const doDia = cache.filter((s) => s.dia_treino === dia && chaveData(s.criado_em) === chave);
  const quando = eHoje ? 'hoje' : 'nesse dia';
  $('#treino-resumo').textContent = doDia.length ? `${doDia.length} ${doDia.length === 1 ? 'série' : 'séries'} ${quando}` : `Nenhuma série ${quando}`;
  $('#treino-icone').dataset.dia = dia;
  $('#treino-semana').replaceChildren(criarSeletorDia(cache.filter((s) => s.dia_treino === dia), renderTreino, { hojePadrao: true }));

  const lista = $('#ex-list');
  lista.innerHTML = '';
  // Em um dia passado, entram também os exercícios que depois saíram da lista do treino.
  const nomes = [...(exerciciosPorDia[dia] || [])];
  if (!eHoje) doDia.forEach((s) => { if (!nomes.includes(s.exercicio)) nomes.push(s.exercicio); });

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
        ? `<span class="ex-count" aria-label="${r.hoje} séries ${quando}">${r.hoje}</span>`
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
  const cancelar = () => clearTimeout(timer);
  el.addEventListener('pointerdown', () => {
    delete el.dataset.longpress;
    timer = setTimeout(() => {
      el.dataset.longpress = '1';
      vibrar(25);
      acao();
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
  enfileirarExercicio(nome);
  processarFila();
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

/* Ao editar, o campo do nome ocupa o lugar do título (ver .is-editando no CSS). */
function modoEdicaoSheet(editando) {
  $('#sheet-novo').classList.toggle('is-editando', editando);
  $('#sheet-title').hidden = editando;
  $('#novo-nome-label').classList.toggle('sr-only', editando);
}

function abrirSheet() {
  estado.editando = null;
  modoEdicaoSheet(false);
  $('#sheet-eyebrow').textContent = `Adicionar · ${NOMES_TREINO[estado.dia]}`;
  $('#sheet-title').textContent = 'Novo exercício';
  $('#sheet-salvar').textContent = 'Adicionar';
  $('#sheet-remover').hidden = true;
  const input = $('#novo-nome');
  input.value = '';
  $('#padrao-reps').value = '';
  $('#padrao-carga').value = '';
  limparErroNome();

  mostrarSheet();
  input.focus({ preventScroll: true });
}

function abrirEdicao(nome) {
  estado.editando = nome;
  modoEdicaoSheet(true);
  $('#sheet-eyebrow').textContent = `Editar · ${NOMES_TREINO[estado.dia]}`;
  $('#sheet-title').textContent = 'Editar exercício';
  $('#sheet-salvar').textContent = 'Salvar';
  $('#sheet-remover').hidden = false;
  $('#novo-nome').value = nome;
  const padrao = padraoDe(nome);
  $('#padrao-reps').value = padrao.reps ?? '';
  $('#padrao-carga').value = padrao.carga == null ? '' : fmtKg(padrao.carga);
  limparErroNome();
  mostrarSheet();
}

/* O nome é a identidade do exercício: renomeia em todos os dias, no cache e no servidor. */
function salvarEdicao(nomeBruto) {
  const de = estado.editando;
  const para = normalizarNome(nomeBruto);
  const input = $('#novo-nome');
  if (!para) { input.classList.add('is-invalid'); input.focus(); return; }

  const existentes = new Set(cache.map((s) => s.exercicio));
  DIAS.forEach((d) => (exerciciosPorDia[d] || []).forEach((n) => existentes.add(n)));
  existentes.delete(de);
  if ([...existentes].some((n) => n.toLowerCase() === para.toLowerCase())) {
    input.classList.add('is-invalid');
    $('#novo-erro').textContent = 'Já existe um exercício com esse nome.';
    $('#novo-erro').hidden = false;
    return;
  }

  const padrao = lerPadraoDoSheet();
  if (para !== de) {
    DIAS.forEach((d) => {
      exerciciosPorDia[d] = (exerciciosPorDia[d] || []).map((n) => (n === de ? para : n));
    });
    gravarExercicios();
    cache.forEach((s) => { if (s.exercicio === de) s.exercicio = para; });
    gravarCache();
    enfileirarRenomear(de, para);
    if (estado.filtroEx === de) estado.filtroEx = para;
    if (estado.exercicio === de) estado.exercicio = para;
    gravarPadrao(de, { reps: null, carga: null });
  }
  gravarPadrao(para, padrao);
  enfileirarExercicio(para);

  vibrar(10);
  fecharSheet();
  renderTreino();
  processarFila();
}

let timerSheet = null;

function mostrarSheet() {
  const sheet = $('#sheet-novo');
  const fundo = $('#sheet-backdrop');
  clearTimeout(timerSheet);
  fundo.hidden = false;
  sheet.hidden = false;
  void sheet.offsetHeight;   // aplica a posição inicial para a transição acontecer
  sheet.classList.add('is-open');
  fundo.classList.add('is-open');
  document.body.classList.add('sheet-aberto');
  document.querySelectorAll('.view').forEach((v) => { v.inert = true; });
  $('#tabbar').inert = true;
  ajustarSheetAoTeclado();
}

function fecharSheet() {
  const sheet = $('#sheet-novo');
  const fundo = $('#sheet-backdrop');
  estado.editando = null;
  $('#novo-nome').blur();
  sheet.classList.remove('is-open');
  fundo.classList.remove('is-open');
  sheet.style.transform = '';
  fundo.style.opacity = '';
  document.body.classList.remove('sheet-aberto');
  document.querySelectorAll('.view').forEach((v) => { v.inert = false; });
  $('#tabbar').inert = !ABAS.has(estado.tela);
  clearTimeout(timerSheet);
  timerSheet = setTimeout(() => {
    fundo.hidden = true;
    sheet.hidden = true;
    sheet.style.bottom = '';
  }, 280);
}

/* Arrastar a alça ou o título para baixo fecha o sheet: basta passar de 30% da altura ou
   dar um movimento rápido. Para cima, resiste cada vez mais em vez de parar de repente. */
function ligarArrasteSheet() {
  const grab = $('#sheet-grab');
  const sheet = $('#sheet-novo');
  const fundo = $('#sheet-backdrop');
  let arraste = null;

  grab.addEventListener('pointerdown', (e) => {
    if (arraste) return;   // um segundo dedo não rouba o arraste
    // Parte de onde o sheet está na tela, mesmo que ainda esteja animando.
    const base = new DOMMatrix(getComputedStyle(sheet).transform).m42;
    arraste = { id: e.pointerId, inicio: e.clientY, base, y: base, amostraY: base, amostraT: e.timeStamp, veloc: 0 };
    grab.setPointerCapture(e.pointerId);
    sheet.classList.add('is-dragging');
    sheet.style.transform = `translate3d(0, ${base}px, 0)`;
  });

  grab.addEventListener('pointermove', (e) => {
    if (!arraste || e.pointerId !== arraste.id) return;
    const bruto = arraste.base + e.clientY - arraste.inicio;
    arraste.y = bruto >= 0 ? bruto : -(Math.abs(bruto) * 200) / (200 + Math.abs(bruto));
    if (e.timeStamp - arraste.amostraT > 60) {
      arraste.veloc = (arraste.y - arraste.amostraY) / (e.timeStamp - arraste.amostraT);
      arraste.amostraY = arraste.y;
      arraste.amostraT = e.timeStamp;
    }
    sheet.style.transform = `translate3d(0, ${arraste.y}px, 0)`;
    fundo.style.opacity = String(1 - Math.max(0, arraste.y) / sheet.offsetHeight);
  });

  const soltar = (e, cancelado) => {
    if (!arraste || e.pointerId !== arraste.id) return;
    const { y, veloc } = arraste;
    arraste = null;
    sheet.classList.remove('is-dragging');
    if (!cancelado && (y > sheet.offsetHeight * 0.3 || (y > 12 && veloc > 0.3))) {
      vibrar(8);
      fecharSheet();
    } else {
      sheet.style.transform = '';
      fundo.style.opacity = '';
    }
  };
  grab.addEventListener('pointerup', (e) => soltar(e, false));
  grab.addEventListener('pointercancel', (e) => soltar(e, true));
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
  // Campos vazios não apagam o padrão de um exercício que já existe em outro treino.
  const padrao = lerPadraoDoSheet();
  if (padrao.reps != null || padrao.carga != null) gravarPadrao(nome, padrao);
  const chaveRemovido = `${estado.dia}|${nome.toLowerCase()}`;
  store.gravar(CHAVES.removidos, store.ler(CHAVES.removidos, []).filter((k) => k !== chaveRemovido));
  enfileirarExercicio(lista.find((n) => n.toLowerCase() === nome.toLowerCase()));
  processarFila();
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
  sheet.style.maxHeight = `${vv.height}px`;
}


/* =====================================================================
   4d. TELA EXERCÍCIO (registro da série) — a principal
   ===================================================================== */

let travaRegistro = false;
let timerFeedback = null;

function abrirExercicio(nome) {
  estado.exercicio = nome;
  estado.diaVerEx = estado.diaSel && estado.diaSel !== hojeChave() ? estado.diaSel : null;
  const ultima = ultimaSerieDe(nome);
  const padrao = padraoDe(nome);
  estado.reps = padrao.reps ?? (ultima ? ultima.repeticoes : REPS_PADRAO);
  estado.carga = padrao.carga ?? (ultima ? ultima.carga_kg : null);
  estado.semCarga = padrao.carga == null && ultima ? ultima.carga_kg == null : false;
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
  // O campo acompanha o número para "65 kg" ficar centralizado no conjunto.
  input.style.width = `${Math.max(input.value.length, 1) + 0.4}ch`;
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

/* Anel em segmentos: azul = feitas, amarelo = a série atual, escuro = as próximas. */
function renderAnel(feitas) {
  const total = Math.max(4, feitas + 1);
  const vao = 4;   // espaço entre segmentos, em % da volta
  const anel = $('#serie-anel');
  anel.innerHTML = Array.from({ length: total }, (_, i) => {
    const tam = 100 / total - vao;
    const classe = i < feitas ? 'is-feita' : i === feitas ? 'is-atual' : '';
    return `<circle class="${classe}" cx="60" cy="60" r="55" pathLength="100" stroke-dasharray="${tam} ${100 - tam}" stroke-dashoffset="${-(i * 100 / total + vao / 2)}"/>`;
  }).join('');
}

function renderExercicio({ animarNova = false } = {}) {
  $('#ex-nome').textContent = estado.exercicio;
  $('#ex-back-label').textContent = NOMES_TREINO[estado.dia];

  const feitas = seriesHoje(estado.dia, estado.exercicio);
  $('#serie-num').textContent = feitas.length + 1;
  renderAnel(feitas.length);

  // O número e o anel são sempre de hoje; "Feitas" pode mostrar outro dia deste exercício.
  const hoje = hojeChave();
  const chaveVer = estado.diaVerEx ?? hoje;
  const vendo = chaveVer === hoje ? feitas : seriesDoDia(estado.dia, estado.exercicio, chaveVer);
  $('#feitas-titulo').textContent = chaveVer === hoje ? 'Feitas hoje' : `Feitas em ${dataCurtinha(chaveVer)}`;
  const datas = [...new Set(cache.filter((s) => s.dia_treino === estado.dia && s.exercicio === estado.exercicio).map((s) => chaveData(s.criado_em)))].sort();
  estado.feitasAnt = datas.filter((k) => k < chaveVer).pop() ?? null;
  estado.feitasProx = chaveVer === hoje ? null : datas.find((k) => k > chaveVer && k < hoje) ?? hoje;
  $('#feitas-ant').hidden = !estado.feitasAnt;
  $('#feitas-prox').hidden = !estado.feitasProx;

  const pend = idsPendentes();
  const chips = $('#feitas-chips');
  chips.innerHTML = '';
  const chaveNova = animarNova && feitas.length ? chaveGrupo(feitas[feitas.length - 1]) : null;
  let chipNovo = null;
  agruparSeries(vendo).forEach((grupo) => {
    const c = criarChipSerie(grupo, 'chip');
    if (c.dataset.chave === chaveNova) { c.classList.add('is-new'); chipNovo = c; }
    if (grupo.some((s) => pend.has(s.id))) c.title = 'Aguardando envio';
    chips.appendChild(c);
  });
  chips.scrollLeft = chipNovo ? chipNovo.offsetLeft - 16 : chaveVer === hoje ? chips.scrollWidth : 0;

  $('#feitas-vazio').hidden = vendo.length > 0;
  $('#feitas-vazio').textContent = chaveVer === hoje ? 'Nenhuma série ainda. Escolha as reps e registre.' : 'Nenhuma série neste dia.';
  $('#btn-desfazer').hidden = chaveVer !== hoje || feitas.length === 0;
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

  estado.diaVerEx = null;   // registrar sempre leva de volta para hoje
  vibrar(18);
  feedbackRegistro(serie);
  renderExercicio({ animarNova: true });
  processarFila();
}

/* O texto do botão troca com um leve desfoque: lê como uma só peça mudando de estado. */
function suavizarTextoCta() {
  ['#cta-main', '#cta-sub'].forEach((sel) => {
    $(sel).animate(
      [{ opacity: 0, filter: 'blur(4px)' }, { opacity: 1, filter: 'blur(0)' }],
      { duration: 200, easing: 'ease' }
    );
  });
}

function feedbackRegistro(serie) {
  const cta = $('#btn-registrar');
  cta.classList.add('is-done');
  $('#cta-main').innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>';
  $('#cta-main').append(` Série ${serie.numero_serie} registrada`);
  $('#cta-sub').textContent = '';
  suavizarTextoCta();
  clearTimeout(timerFeedback);
  timerFeedback = setTimeout(() => { cta.classList.remove('is-done'); renderControles(); suavizarTextoCta(); }, 900);

  const num = $('#serie-num');
  num.classList.remove('bump'); void num.offsetWidth; num.classList.add('bump');

  // Quem usa leitor de tela ouve a confirmação que os outros veem no botão.
  $('#anuncio').textContent = `Série ${serie.numero_serie} registrada: ${fmtSerie(serie.repeticoes, serie.carga_kg)}`;
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
  $('#feitas-ant').addEventListener('click', () => { estado.diaVerEx = estado.feitasAnt; vibrar(5); renderExercicio(); });
  $('#feitas-prox').addEventListener('click', () => {
    estado.diaVerEx = estado.feitasProx === hojeChave() ? null : estado.feitasProx;
    vibrar(5);
    renderExercicio();
  });
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

function renderSemanaHistorico(dias) {
  const periodo = document.createElement('span');
  periodo.className = 'seletor-periodo';
  periodo.textContent = periodoDaSemana(dias);
  const [anterior, proxima] = criarSetasSemana(() => { renderHistorico(); $('#hist-scroll').scrollTop = 0; });
  $('#hist-semana').replaceChildren(anterior, periodo, proxima);
}

function renderResumoHistorico(filtradas) {
  const box = $('#hist-resumo');
  box.innerHTML = '';
  if (!filtradas.length) return;

  const treinos = new Set(filtradas.map((s) => `${chaveData(s.criado_em)}|${s.dia_treino}`)).size;
  const stats = [
    ['Treinos', treinos, 'A', '<path d="M12 3c1 3 5 5 5 10a5 5 0 0 1-10 0c0-2 1-3 2-4 0 2 1 3 2 3 1-3 0-6 1-9Z"/>'],
    ['Séries', filtradas.length, 'D', '<path d="M6 7v10M18 7v10M3 10v4M21 10v4M6 12h12"/>'],
  ];
  const tiles = document.createElement('div');
  tiles.className = 'hist-stats';
  stats.forEach(([rotulo, valor, cor, icone]) => {
    const t = document.createElement('div');
    t.className = 'hist-stat';
    t.dataset.dia = cor;
    t.innerHTML = `<span></span><svg viewBox="0 0 24 24" aria-hidden="true">${icone}</svg><strong></strong>`;
    t.querySelector('span').textContent = rotulo;
    t.querySelector('strong').textContent = valor;
    tiles.appendChild(t);
  });
  box.appendChild(tiles);
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

  const dias = diasDaSemana();
  renderSemanaHistorico(dias);
  const [primeiroDia, ultimoDia] = [chaveData(dias[0]), chaveData(dias[6])];

  const filtradas = cache
    .filter((s) => { const k = chaveData(s.criado_em); return k >= primeiroDia && k <= ultimoDia; })
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
      grupo.querySelector('.hist-badge').dataset.dia = dia;
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
    vazio.textContent = !cache.length
      ? 'Nenhuma série registrada ainda. Bora treinar!'
      : estado.filtroDia !== 'todos' || estado.filtroEx !== 'todos'
      ? 'Nenhuma série com esses filtros nesta semana.'
      : 'Nenhum treino nesta semana.';
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
   4f. TELA GRÁFICOS
   Métricas do modelo de planilha: séries, reps, volume, 1RM estimado (Epley),
   recorde, maior carga, evolução e volume contra a sessão anterior.
   ===================================================================== */

const COR_LINHA = '#5B63EE', COR_DESTAQUE = '#F9D55B', COR_PICO = '#F57E20', COR_GRADE = 'rgba(255,255,255,0.08)',
  COR_TEXTO = 'rgba(255,255,255,0.55)', COR_FUNDO = '#232323';

const METRICAS = {
  rm: { rotulo: '1RM', titulo: '1RM estimado', fmt: (v) => `${fmtKg(v)} kg` },
  carga: { rotulo: 'Carga', titulo: 'Maior carga', fmt: (v) => `${fmtKg(v)} kg` },
  volume: { rotulo: 'Volume', titulo: 'Volume', fmt: fmtVolume },
  reps: { rotulo: 'Reps', titulo: 'Total de reps', fmt: (v) => `${fmtKg(v)} reps` },
  series: { rotulo: 'Séries', titulo: 'Séries feitas', fmt: (v) => `${fmtKg(v)} ${v === 1 ? 'série' : 'séries'}` },
  treinos: { rotulo: 'Treinos', titulo: 'Treinos', fmt: (v) => `${fmtKg(v)} ${v === 1 ? 'treino' : 'treinos'}` },
};

function resumirSeries(series) {
  const r = { series: series.length, reps: 0, volume: 0, rm: 0, carga: 0 };
  series.forEach((s) => {
    r.reps += s.repeticoes;
    if (s.carga_kg == null) return;
    r.volume += s.repeticoes * s.carga_kg;
    r.carga = Math.max(r.carga, s.carga_kg);
    r.rm = Math.max(r.rm, s.carga_kg * (1 + s.repeticoes / 30));
  });
  return r;
}

/* Uma sessão é um exercício em uma data: as séries daquele dia viram um único ponto. */
function sessoesPorData(series) {
  const porData = new Map();
  series.forEach((s) => {
    const k = chaveData(s.criado_em);
    if (!porData.has(k)) porData.set(k, []);
    porData.get(k).push(s);
  });
  return [...porData.keys()].sort().map((chave) => ({ chave, lista: porData.get(chave), ...resumirSeries(porData.get(chave)) }));
}

function inicioPeriodo(periodo = estado.grafPeriodo) {
  if (periodo === 'tudo') return null;
  const d = new Date(); d.setDate(d.getDate() - Number(periodo) + 1);
  return chaveData(d);
}

const doTreinoFiltrado = (s) => estado.grafTreino === 'todos' || s.dia_treino === estado.grafTreino;

function eixoLimpo(min, max) {
  if (min === max) { min = Math.max(0, min - 1); max += 1; }
  const bruto = (max - min) / 3;
  const pot = 10 ** Math.floor(Math.log10(bruto));
  const passo = [1, 2, 2.5, 5, 10].map((m) => m * pot).find((p) => p >= bruto);
  const ini = Math.floor(min / passo) * passo;
  const fim = Math.ceil(max / passo) * passo;
  const marcas = [];
  for (let v = ini; v <= fim + passo / 2; v += passo) marcas.push(v);
  return marcas;
}

const fmtEixo = (v) => (v >= 1000 ? `${(v / 1000).toLocaleString('pt-BR', { maximumFractionDigits: 1 })}k` : v.toLocaleString('pt-BR', { maximumFractionDigits: 1 }));
const larguraGrafico = () => Math.max(220, Math.min(480, $('#graf-scroll').clientWidth) - 64);

function grade(marcas, y, W, esq) {
  return marcas.map((v) => `<line x1="${esq}" x2="${W}" y1="${y(v)}" y2="${y(v)}" stroke="${COR_GRADE}"/>`
    + `<text x="${esq - 6}" y="${y(v) + 4}" text-anchor="end" font-size="11" fill="${COR_TEXTO}">${fmtEixo(v)}</text>`).join('');
}

function ligarAlvos(svg, escolher) {
  svg.querySelectorAll('[data-i]').forEach((alvo) => {
    alvo.addEventListener('click', () => escolher(Number(alvo.dataset.i)));
    alvo.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); escolher(Number(alvo.dataset.i)); }
    });
  });
}

/* Evolução no tempo: o eixo x respeita a distância real entre as datas. */
function criarLinha(pontos, fmt) {
  const box = document.createElement('div');
  const leitura = document.createElement('p');
  leitura.className = 'gr-leitura';
  box.appendChild(leitura);
  const W = larguraGrafico(), H = 176, esq = 34, dir = 10, topo = 12, base = 24;
  const dias = (k) => parseChave(k).getTime() / 86400000;
  const d0 = dias(pontos[0].chave), d1 = dias(pontos[pontos.length - 1].chave);
  const x = (k) => (d1 === d0 ? (esq + W - dir) / 2 : esq + ((dias(k) - d0) / (d1 - d0)) * (W - esq - dir));
  const marcas = eixoLimpo(Math.min(...pontos.map((p) => p.valor)), Math.max(...pontos.map((p) => p.valor)));
  const y = (v) => topo + (1 - (v - marcas[0]) / (marcas[marcas.length - 1] - marcas[0])) * (H - topo - base);
  const caminho = pontos.map((p, i) => `${i ? 'L' : 'M'}${x(p.chave).toFixed(1)} ${y(p.valor).toFixed(1)}`).join(' ');
  const fundoY = H - base;
  const rotulos = (d1 === d0 ? [pontos[0]] : [pontos[0], pontos[pontos.length - 1]])
    .map((p, i, l) => `<text x="${x(p.chave)}" y="${H - 6}" font-size="11" fill="${COR_TEXTO}" text-anchor="${l.length === 1 ? 'middle' : i ? 'end' : 'start'}">${dataCurtinha(p.chave)}</text>`).join('');

  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'gr-svg');
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  const desenhar = () => {
    let sel = pontos.findIndex((p) => p.chave === estado.diaSel);
    if (sel < 0) sel = pontos.length - 1;
    const atual = pontos[sel];
    const densos = pontos.length > 24;
    const pontosSvg = pontos.map((p, i) => {
      if (densos && !p.pr && i !== sel) return '';
      const destaque = i === sel;
      return `<circle cx="${x(p.chave)}" cy="${y(p.valor)}" r="${destaque ? 6 : 4}" fill="${p.pr ? COR_DESTAQUE : COR_LINHA}" stroke="${COR_FUNDO}" stroke-width="2"/>`;
    }).join('');
    const alvos = pontos.map((p, i) => {
      const ant = i ? (x(pontos[i - 1].chave) + x(p.chave)) / 2 : 0;
      const prox = i < pontos.length - 1 ? (x(p.chave) + x(pontos[i + 1].chave)) / 2 : W;
      return `<rect data-i="${i}" x="${ant}" y="0" width="${prox - ant}" height="${H}" fill="transparent" tabindex="0" role="button" aria-label="${dataCurtinha(p.chave)}: ${fmt(p.valor)}${p.pr ? ', recorde' : ''}"/>`;
    }).join('');
    svg.innerHTML = grade(marcas, y, W, esq)
      + (pontos.length > 1 ? `<path d="${caminho} L${x(pontos[pontos.length - 1].chave)} ${fundoY} L${x(pontos[0].chave)} ${fundoY} Z" fill="${COR_LINHA}" opacity="0.1"/><path d="${caminho}" fill="none" stroke="${COR_LINHA}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>` : '')
      + `<line x1="${x(atual.chave)}" x2="${x(atual.chave)}" y1="${topo}" y2="${fundoY}" stroke="rgba(255,255,255,0.28)"/>`
      + pontosSvg + rotulos + alvos;
    leitura.innerHTML = '<strong></strong><span></span>';
    leitura.firstChild.textContent = fmt(atual.valor);
    leitura.lastChild.textContent = `${dataCurtinha(atual.chave)}${atual.pr ? ' · recorde' : ''}`;
    ligarAlvos(svg, (i) => selecionarDia(pontos[i].chave, () => renderGraficos({ ancorar: true }), true));
  };
  desenhar();
  box.appendChild(svg);
  return box;
}

/* Barras de uma série só; tocar mostra o valor daquela barra na leitura acima do gráfico. */
function criarBarras(pontos, fmt) {
  const box = document.createElement('div');
  const leitura = document.createElement('p');
  leitura.className = 'gr-leitura';
  box.appendChild(leitura);
  const W = larguraGrafico(), H = 156, esq = 34, topo = 8, base = 24;
  const marcas = eixoLimpo(0, Math.max(1, ...pontos.map((p) => p.valor)));
  const maxY = marcas[marcas.length - 1];
  const y = (v) => topo + (1 - v / maxY) * (H - topo - base);
  const vaga = (W - esq) / pontos.length;
  const larg = Math.min(24, Math.max(3, vaga - 2));
  const cada = Math.ceil(pontos.length / 6);
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'gr-svg');
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  let sel = pontos.length - 1;
  const desenhar = () => {
    const atual = pontos[sel];
    const barras = pontos.map((p, i) => {
      const cx = esq + vaga * (i + 0.5), x0 = cx - larg / 2, yv = y(p.valor), y0 = y(0);
      const r = Math.min(4, larg / 2, y0 - yv);
      const forma = p.valor > 0
        ? `<path d="M${x0} ${y0} V${yv + r} Q${x0} ${yv} ${x0 + r} ${yv} H${x0 + larg - r} Q${x0 + larg} ${yv} ${x0 + larg} ${yv + r} V${y0} Z" fill="${i === sel ? COR_PICO : COR_DESTAQUE}"/>`
        : '';
      const rot = (pontos.length - 1 - i) % cada === 0 ? `<text x="${cx}" y="${H - 6}" text-anchor="middle" font-size="11" fill="${COR_TEXTO}">${p.curto}</text>` : '';
      return `${forma}${rot}<rect data-i="${i}" x="${esq + vaga * i}" y="0" width="${vaga}" height="${H}" fill="transparent" tabindex="0" role="button" aria-label="${p.rotulo}: ${fmt(p.valor)}"/>`;
    }).join('');
    svg.innerHTML = grade(marcas, y, W, esq) + barras;
    leitura.innerHTML = '<strong></strong><span></span>';
    leitura.firstChild.textContent = fmt(atual.valor);
    leitura.lastChild.textContent = atual.rotulo;
    ligarAlvos(svg, (i) => {
      sel = i;
      desenhar();
    });
  };
  desenhar();
  box.appendChild(svg);
  return box;
}

function baldesDoPeriodo(series) {
  const hoje = new Date();
  const inicioK = inicioPeriodo() ?? (series.length ? series.map((s) => chaveData(s.criado_em)).sort()[0] : hojeChave());
  const inicio = parseChave(inicioK);
  const span = Math.round((hoje - inicio) / 86400000);
  const tipo = span <= 7 ? 'dia' : span <= 182 ? 'semana' : 'mes';
  const baldes = [];
  const cursor = new Date(inicio);
  if (tipo === 'semana') cursor.setDate(cursor.getDate() - (cursor.getDay() + 6) % 7);
  if (tipo === 'mes') cursor.setDate(1);
  while (cursor <= hoje) {
    const ini = new Date(cursor);
    if (tipo === 'dia') cursor.setDate(cursor.getDate() + 1);
    else if (tipo === 'semana') cursor.setDate(cursor.getDate() + 7);
    else cursor.setMonth(cursor.getMonth() + 1);
    const fimEx = new Date(cursor);
    const fim = new Date(fimEx); fim.setDate(fim.getDate() - 1);
    const mes = capitalizar(ini.toLocaleDateString('pt-BR', { month: 'short' }).replace('.', ''));
    baldes.push({
      de: chaveData(ini), ate: chaveData(fim),
      curto: tipo === 'mes' ? mes : tipo === 'dia' ? capitalizar(ini.toLocaleDateString('pt-BR', { weekday: 'short' }).replace('.', '')).slice(0, 3) : `${ini.getDate()}/${ini.getMonth() + 1}`,
      rotulo: tipo === 'mes' ? `${mes} de ${ini.getFullYear()}` : tipo === 'dia' ? capitalizar(dataCurta(ini)) : `Semana de ${dataCurtinha(chaveData(ini))}`,
    });
  }
  return baldes;
}

function valorGeral(series, metrica) {
  if (metrica === 'treinos') return new Set(series.map((s) => `${chaveData(s.criado_em)}|${s.dia_treino}`)).size;
  return resumirSeries(series)[metrica];
}

function criarSecao(titulo, sub) {
  const sec = document.createElement('section');
  sec.className = 'gr-card';
  sec.dataset.ancora = titulo;
  sec.innerHTML = '<h2 class="gr-titulo"></h2>';
  sec.firstChild.textContent = titulo;
  if (sub) {
    const p = document.createElement('p');
    p.className = 'gr-sub';
    p.textContent = sub;
    sec.appendChild(p);
  }
  return sec;
}

function criarChips(opcoes, valor, aoEscolher, rotulo) {
  const grupo = document.createElement('div');
  grupo.className = 'dia-chips';
  grupo.style.setProperty('--n', opcoes.length);
  grupo.setAttribute('role', 'group');
  grupo.setAttribute('aria-label', rotulo);
  opcoes.forEach(([v, texto]) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = texto;
    b.setAttribute('aria-pressed', String(v === valor));
    b.addEventListener('click', () => { vibrar(5); aoEscolher(v); renderGraficos(); });
    grupo.appendChild(b);
  });
  return grupo;
}

function criarTile(rotulo, valor, cor, nota) {
  const t = document.createElement('div');
  t.className = 'hist-stat gr-tile';
  if (cor) t.dataset.dia = cor;
  t.innerHTML = '<span></span><strong></strong><small></small>';
  t.querySelector('span').textContent = rotulo;
  t.querySelector('strong').textContent = valor;
  t.querySelector('small').textContent = nota || '';
  return t;
}

function fmtDelta(atual, anterior) {
  if (!anterior) return '';
  const p = Math.round((atual / anterior - 1) * 100);
  return `${p > 0 ? '▲' : p < 0 ? '▼' : '='} ${Math.abs(p)}% vs anterior`;
}

function semanasSeguidas(series) {
  const segunda = (d) => { const x = new Date(d); x.setDate(x.getDate() - (x.getDay() + 6) % 7); return chaveData(x); };
  const semanas = new Set(series.map((s) => segunda(new Date(s.criado_em))));
  const c = new Date();
  if (!semanas.has(segunda(c))) c.setDate(c.getDate() - 7);   // a semana atual ainda pode ter treino
  let n = 0;
  while (semanas.has(segunda(c))) { n++; c.setDate(c.getDate() - 7); }
  return n;
}

function contarRecordes(porExercicio, inicio) {
  let n = 0;
  porExercicio.forEach((sessoes) => {
    let melhor = 0;
    sessoes.forEach((s) => {
      if (melhor > 0 && s.rm > melhor && (!inicio || s.chave >= inicio)) n++;
      melhor = Math.max(melhor, s.rm);
    });
  });
  return n;
}

function criarGradeResumo(sessoes) {
  const prim = sessoes[0], ult = sessoes[sessoes.length - 1], ant = sessoes[sessoes.length - 2];
  const pct = (a, b) => (b ? `${a >= b ? '+' : ''}${(((a / b) - 1) * 100).toLocaleString('pt-BR', { maximumFractionDigits: 1 })}%` : '—');
  const kg = (v) => (v ? `${fmtKg(v)} kg` : '—');
  const linhas = [
    ['Sessões', sessoes.length],
    ['Primeira data', dataCurtinha(prim.chave)],
    ['Última data', dataCurtinha(ult.chave)],
    ['1RM inicial', kg(prim.rm)],
    ['1RM atual', kg(ult.rm)],
    ['Evolução', sessoes.length > 1 ? pct(ult.rm, prim.rm) : '—'],
    ['Recorde 1RM', kg(Math.max(...sessoes.map((s) => s.rm)))],
    ['Maior carga', kg(Math.max(...sessoes.map((s) => s.carga)))],
    ['Volume última', fmtVolume(ult.volume)],
    ['Volume anterior', ant ? fmtVolume(ant.volume) : '—'],
    ['Volume vs anterior', ant ? pct(ult.volume, ant.volume) : '—'],
  ];
  const dl = document.createElement('dl');
  dl.className = 'gr-grade';
  linhas.forEach(([rot, val]) => {
    const d = document.createElement('div');
    d.innerHTML = '<dt></dt><dd></dd>';
    d.firstChild.textContent = rot;
    d.lastChild.textContent = val;
    dl.appendChild(d);
  });
  return dl;
}

function criarMini(sessoes) {
  const v = sessoes.map((s) => s.rm || s.reps);
  const min = Math.min(...v), max = Math.max(...v), W = 56, H = 22;
  const px = (i) => (v.length > 1 ? (i / (v.length - 1)) * (W - 6) + 3 : W / 2);
  const py = (x) => (max === min ? H / 2 : H - 3 - ((x - min) / (max - min)) * (H - 6));
  const c = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  c.setAttribute('class', 'gr-mini');
  c.setAttribute('viewBox', `0 0 ${W} ${H}`);
  c.setAttribute('aria-hidden', 'true');
  c.innerHTML = (v.length > 1 ? `<polyline points="${v.map((x, i) => `${px(i).toFixed(1)},${py(x).toFixed(1)}`).join(' ')}" fill="none" stroke="${COR_LINHA}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>` : '')
    + `<circle cx="${px(v.length - 1)}" cy="${py(v[v.length - 1])}" r="3" fill="${COR_LINHA}"/>`;
  return c;
}

function criarDetalheDia(chave, series) {
  const sec = criarSecao(capitalizar(dataCurta(parseChave(chave))));
  delete sec.dataset.ancora;   // este card muda a cada dia escolhido
  const doDia = series.filter((s) => chaveData(s.criado_em) === chave);
  if (!doDia.length) {
    const p = document.createElement('p');
    p.className = 'gr-sub';
    p.textContent = 'Nenhuma série neste dia.';
    sec.appendChild(p);
    return sec;
  }
  const r = resumirSeries(doDia);
  const p = document.createElement('p');
  p.className = 'gr-sub';
  p.textContent = [METRICAS.series.fmt(r.series), METRICAS.reps.fmt(r.reps), fmtVolume(r.volume)].join(' · ');
  sec.appendChild(p);
  const porEx = new Map();
  doDia.forEach((s) => { if (!porEx.has(s.exercicio)) porEx.set(s.exercicio, []); porEx.get(s.exercicio).push(s); });
  porEx.forEach((lista, nome) => {
    lista.sort((a, b) => a.numero_serie - b.numero_serie);
    const rs = resumirSeries(lista);
    const ex = document.createElement('div');
    ex.className = 'hist-ex gr-dia-ex';
    ex.innerHTML = '<div class="hist-ex-head"><strong></strong><span class="hist-tag"></span></div><div class="hist-sets"></div>';
    ex.querySelector('strong').textContent = nome;
    ex.querySelector('.hist-tag').textContent = rs.rm ? `1RM ${fmtKg(rs.rm)} kg` : `${rs.reps} reps`;
    agruparSeries(lista).forEach((g) => ex.querySelector('.hist-sets').appendChild(criarChipSerie(g, 'hist-set')));
    sec.appendChild(ex);
  });
  return sec;
}

function criarMapaCalor(series) {
  const sec = criarSecao('Consistência', 'Séries por dia nas últimas semanas');
  const colunas = Math.floor((larguraGrafico() + 3) / 19);
  const contagem = new Map();
  series.forEach((s) => { const k = chaveData(s.criado_em); contagem.set(k, (contagem.get(k) || 0) + 1); });
  const max = Math.max(1, ...contagem.values());
  const inicio = new Date();
  inicio.setDate(inicio.getDate() - (inicio.getDay() + 6) % 7 - (colunas - 1) * 7);
  const mapa = document.createElement('div');
  mapa.className = 'gr-mapa';
  mapa.style.setProperty('--colunas', colunas);
  const hoje = hojeChave();
  for (let i = 0; i < colunas * 7; i++) {
    const d = new Date(inicio); d.setDate(d.getDate() + i);
    const k = chaveData(d);
    const n = contagem.get(k) || 0;
    if (k > hoje) { mapa.appendChild(document.createElement('span')); continue; }
    const c = document.createElement('button');
    c.type = 'button';
    c.className = 'gr-celula' + (k === estado.diaSel ? ' is-sel' : '');
    c.dataset.nivel = n ? Math.ceil((n / max) * 4) : 0;
    c.setAttribute('aria-label', `${dataCurta(d)}: ${METRICAS.series.fmt(n)}`);
    c.addEventListener('click', () => selecionarDia(k, () => { renderGraficos(); $('#graf-scroll').scrollTop = 0; }));
    mapa.appendChild(c);
  }
  sec.appendChild(mapa);
  const legenda = document.createElement('div');
  legenda.className = 'gr-legenda';
  legenda.setAttribute('aria-hidden', 'true');
  legenda.innerHTML = 'Menos<i data-nivel="0"></i><i data-nivel="1"></i><i data-nivel="2"></i><i data-nivel="3"></i><i data-nivel="4"></i>Mais';
  sec.appendChild(legenda);
  return sec;
}

function criarEvolucaoExercicio(noPeriodo, todasDoTreino) {
  const sec = criarSecao('Evolução por exercício');
  const nomes = [...new Set(noPeriodo.map((s) => s.exercicio))].sort((a, b) => a.localeCompare(b, 'pt-BR'));
  if (!nomes.length) {
    const p = document.createElement('p');
    p.className = 'gr-sub';
    p.textContent = 'Nenhuma série com esses filtros.';
    sec.appendChild(p);
    return sec;
  }
  if (!nomes.includes(estado.grafEx)) {
    const conta = new Map();
    noPeriodo.forEach((s) => conta.set(s.exercicio, (conta.get(s.exercicio) || 0) + 1));
    estado.grafEx = [...conta.entries()].sort((a, b) => b[1] - a[1])[0][0];   // começa pelo mais treinado
  }
  const wrap = document.createElement('label');
  wrap.className = 'select-wrap gr-select';
  wrap.innerHTML = '<span class="sr-only">Exercício</span><select></select><svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>';
  const sel = wrap.querySelector('select');
  nomes.forEach((n) => sel.append(new Option(n, n)));
  sel.value = estado.grafEx;
  sel.addEventListener('change', () => { estado.grafEx = sel.value; renderGraficos(); });
  sec.appendChild(wrap);
  sec.appendChild(criarChips(['rm', 'carga', 'volume', 'reps', 'series'].map((m) => [m, METRICAS[m].rotulo]), estado.grafMetrica, (m) => { estado.grafMetrica = m; }, 'Métrica'));

  const sessoes = sessoesPorData(noPeriodo.filter((s) => s.exercicio === estado.grafEx));
  const historicas = sessoesPorData(todasDoTreino.filter((s) => s.exercicio === estado.grafEx));
  const recordes = new Set();
  let melhor = 0;
  historicas.forEach((s) => { if (melhor > 0 && s.rm > melhor) recordes.add(s.chave); melhor = Math.max(melhor, s.rm); });
  const m = METRICAS[estado.grafMetrica];
  const pontos = sessoes.filter((s) => s[estado.grafMetrica] > 0).map((s) => ({ chave: s.chave, valor: s[estado.grafMetrica], pr: estado.grafMetrica === 'rm' && recordes.has(s.chave) }));
  if (pontos.length) {
    sec.appendChild(criarLinha(pontos, m.fmt));
    if (pontos.length === 1) {
      const p = document.createElement('p');
      p.className = 'gr-sub';
      p.textContent = 'Registre mais uma sessão para ver a evolução.';
      sec.appendChild(p);
    }
  } else {
    const p = document.createElement('p');
    p.className = 'gr-sub';
    p.textContent = 'Este exercício não tem carga registrada. Veja Reps ou Séries.';
    sec.appendChild(p);
  }
  sec.appendChild(criarGradeResumo(sessoes));
  return sec;
}

/* Com ancorar, o card tocado fica no mesmo lugar da tela mesmo que o detalhe do dia entre acima dele. */
function renderGraficos({ ancorar = false } = {}) {
  const scroll = $('#graf-scroll');
  const topoAntes = scroll.scrollTop;
  const topoScroll = scroll.getBoundingClientRect().top;
  const ancora = ancorar ? [...scroll.querySelectorAll('[data-ancora]')].find((c) => c.getBoundingClientRect().bottom > topoScroll) : null;
  const ancoraNome = ancora?.dataset.ancora;
  const ancoraTopo = ancora?.getBoundingClientRect().top;
  const frag = document.createDocumentFragment();
  const doTreino = cache.filter(doTreinoFiltrado);
  const inicio = inicioPeriodo();
  const noPeriodo = doTreino.filter((s) => !inicio || chaveData(s.criado_em) >= inicio);

  const filtros = document.createElement('div');
  filtros.className = 'filter-bar';
  filtros.appendChild(criarChips([['7', '7 dias'], ['30', '30 dias'], ['90', '90 dias'], ['365', '1 ano'], ['tudo', 'Tudo']], estado.grafPeriodo, (v) => { estado.grafPeriodo = v; }, 'Período'));
  filtros.appendChild(criarChips([['todos', 'Todos'], ['A', 'Peito'], ['B', 'Costas'], ['C', 'Leg'], ['D', 'Ombro']], estado.grafTreino, (v) => { estado.grafTreino = v; }, 'Treino'));
  frag.appendChild(filtros);
  frag.appendChild(criarSeletorDia(doTreino, renderGraficos));

  if (estado.diaSel) frag.appendChild(criarDetalheDia(estado.diaSel, doTreino));

  if (!cache.length) {
    const vazio = document.createElement('p');
    vazio.className = 'empty';
    vazio.textContent = 'Registre suas séries para ver a evolução aqui.';
    frag.appendChild(vazio);
  } else {
    // Totais do período, comparados ao período anterior de mesmo tamanho
    const total = resumirSeries(noPeriodo);
    let anteriores = [];
    if (inicio) {
      const d = parseChave(inicio); d.setDate(d.getDate() - Number(estado.grafPeriodo));
      const iniAnt = chaveData(d);
      anteriores = doTreino.filter((s) => { const k = chaveData(s.criado_em); return k >= iniAnt && k < inicio; });
    }
    const totalAnt = resumirSeries(anteriores);
    const porExercicio = new Map();
    doTreino.forEach((s) => { if (!porExercicio.has(s.exercicio)) porExercicio.set(s.exercicio, []); porExercicio.get(s.exercicio).push(s); });
    porExercicio.forEach((lista, nome) => porExercicio.set(nome, sessoesPorData(lista)));

    const tiles = document.createElement('div');
    tiles.className = 'hist-stats gr-tiles';
    tiles.append(
      criarTile('Treinos', valorGeral(noPeriodo, 'treinos'), 'A', fmtDelta(valorGeral(noPeriodo, 'treinos'), valorGeral(anteriores, 'treinos'))),
      criarTile('Séries', total.series, 'B', fmtDelta(total.series, totalAnt.series)),
      criarTile('Reps', total.reps.toLocaleString('pt-BR'), 'C', fmtDelta(total.reps, totalAnt.reps)),
      criarTile('Volume', fmtVolume(total.volume), 'D', fmtDelta(total.volume, totalAnt.volume)),
      criarTile('Recordes batidos', contarRecordes(porExercicio, inicio), null, 'de 1RM estimado'),
      criarTile('Semanas seguidas', semanasSeguidas(doTreino), null, 'com treino'),
    );
    frag.appendChild(tiles);

    frag.appendChild(criarEvolucaoExercicio(noPeriodo, doTreino));

    // Evolução geral do treino
    const geral = criarSecao('Evolução geral');
    geral.appendChild(criarChips(['series', 'reps', 'volume', 'treinos'].map((m) => [m, METRICAS[m].rotulo]), estado.grafGeral, (m) => { estado.grafGeral = m; }, 'Métrica geral'));
    const baldes = baldesDoPeriodo(noPeriodo).map((b) => ({
      ...b,
      valor: valorGeral(noPeriodo.filter((s) => { const k = chaveData(s.criado_em); return k >= b.de && k <= b.ate; }), estado.grafGeral),
    }));
    geral.appendChild(criarBarras(baldes, METRICAS[estado.grafGeral].fmt));
    frag.appendChild(geral);

    // Distribuição por treino: o nome ao lado da barra identifica cada um
    const dist = criarSecao('Séries por treino', 'No período selecionado');
    const noPeriodoTodos = cache.filter((s) => !inicio || chaveData(s.criado_em) >= inicio);
    const contaDia = DIAS.map((d) => [d, noPeriodoTodos.filter((s) => s.dia_treino === d).length]);
    const maxDia = Math.max(1, ...contaDia.map(([, n]) => n));
    contaDia.sort((a, b) => b[1] - a[1]).forEach(([d, n]) => {
      const l = document.createElement('div');
      l.className = 'gr-dist';
      l.dataset.dia = d;
      l.innerHTML = '<span class="gr-dist-nome"></span><span class="gr-dist-trilha"><i></i></span><span class="gr-dist-n"></span>';
      l.querySelector('.gr-dist-nome').textContent = NOMES_TREINO[d].replace(' Day', '');
      l.querySelector('i').style.width = `${(n / maxDia) * 100}%`;
      l.querySelector('.gr-dist-n').textContent = n;
      dist.appendChild(l);
    });
    frag.appendChild(dist);

    frag.appendChild(criarMapaCalor(doTreino));

    // Recordes de todo o histórico, os mais recentes primeiro
    const rec = criarSecao('Recordes', 'De todo o histórico, pelo 1RM estimado');
    const seteDias = new Date(); seteDias.setDate(seteDias.getDate() - 6);
    const limiteNovo = chaveData(seteDias);
    const listaRec = [...porExercicio.entries()].map(([nome, sessoes]) => {
      const melhorS = sessoes.reduce((m, s) => (s.rm > m.rm ? s : m), sessoes[0]);
      return { nome, melhorS, carga: Math.max(...sessoes.map((s) => s.carga)), novo: sessoes.length > 1 && melhorS.chave !== sessoes[0].chave && melhorS.chave >= limiteNovo };
    }).filter((r) => r.melhorS.rm > 0).sort((a, b) => b.melhorS.chave.localeCompare(a.melhorS.chave));
    listaRec.forEach((r) => {
      const l = document.createElement('div');
      l.className = 'gr-recorde';
      l.innerHTML = '<div><strong></strong><span></span></div><div class="gr-recorde-valor"><b></b><span></span></div>';
      l.querySelector('strong').textContent = r.nome;
      l.querySelector('div span').textContent = `Maior carga ${fmtKg(r.carga)} kg`;
      l.querySelector('b').textContent = `${fmtKg(r.melhorS.rm)} kg`;
      l.querySelector('.gr-recorde-valor span').textContent = `${r.novo ? 'Novo · ' : ''}${dataCurtinha(r.melhorS.chave)}`;
      rec.appendChild(l);
    });
    if (!listaRec.length) {
      const p = document.createElement('p');
      p.className = 'gr-sub';
      p.textContent = 'Registre séries com carga para ver seus recordes.';
      rec.appendChild(p);
    }
    frag.appendChild(rec);

    // Resumo por exercício: a mesma tabela da planilha, um exercício aberto por vez
    const tab = criarSecao('Resumo por exercício', 'Toque para ver os detalhes do período');
    const noPeriodoPorEx = new Map();
    noPeriodo.forEach((s) => { if (!noPeriodoPorEx.has(s.exercicio)) noPeriodoPorEx.set(s.exercicio, []); noPeriodoPorEx.get(s.exercicio).push(s); });
    [...noPeriodoPorEx.entries()].sort((a, b) => a[0].localeCompare(b[0], 'pt-BR')).forEach(([nome, lista]) => {
      const sessoes = sessoesPorData(lista);
      const det = document.createElement('details');
      det.className = 'gr-resumo';
      det.name = 'gr-resumo';
      const sum = document.createElement('summary');
      sum.innerHTML = '<span class="gr-resumo-nome"></span>';
      sum.firstChild.textContent = nome;
      sum.appendChild(criarMini(sessoes));
      const ini = sessoes[0].rm, fim = sessoes[sessoes.length - 1].rm;
      if (sessoes.length > 1 && ini) {
        const tag = document.createElement('span');
        const p = Math.round((fim / ini - 1) * 100);
        tag.className = 'hist-tag' + (p > 0 ? ' is-up' : '');
        tag.textContent = `${p > 0 ? '+' : ''}${p}%`;
        sum.appendChild(tag);
      }
      det.append(sum, criarGradeResumo(sessoes));
      tab.appendChild(det);
    });
    frag.appendChild(tab);
  }

  $('#graf-conteudo').replaceChildren(frag);
  scroll.scrollTop = topoAntes;
  const novaAncora = ancoraNome && [...scroll.querySelectorAll('[data-ancora]')].find((c) => c.dataset.ancora === ancoraNome);
  if (novaAncora) scroll.scrollTop += novaAncora.getBoundingClientRect().top - ancoraTopo;
}


/* =====================================================================
   5. NAVEGAÇÃO, EVENTOS GLOBAIS E SERVICE WORKER
   ===================================================================== */

const PROFUNDIDADE = { inicio: 0, historico: 1, graficos: 1, treino: 1, exercicio: 2 };
const ABAS = new Set(['inicio', 'historico', 'graficos']);
const rolagens = {};   // posição de cada tela, para voltar ao mesmo ponto da lista

function listaRolavel(view) { return view.querySelector('.scroll-list, .hist-scroll'); }

function mostrar(tela, { animar = true } = {}) {
  const views = [...document.querySelectorAll('.view')];
  const saindo = views.find((v) => v.dataset.view === estado.tela);
  const entrando = views.find((v) => v.dataset.view === tela);
  const voltando = PROFUNDIDADE[tela] < PROFUNDIDADE[estado.tela];
  const entreAbas = ABAS.has(tela) && ABAS.has(estado.tela);   // trocar de aba não desliza a tela

  const listaSaindo = listaRolavel(saindo);
  rolagens[estado.tela] = { view: saindo.scrollTop, lista: listaSaindo ? listaSaindo.scrollTop : 0 };

  // Uma troca no meio de outra continua da posição em que as telas estão agora.
  const posicoes = new Map();
  views.forEach((v) => {
    const animacoes = v.getAnimations();
    if (animacoes.length) {
      const cs = getComputedStyle(v);
      posicoes.set(v, { transform: cs.transform, opacity: cs.opacity });
    }
    animacoes.forEach((a) => a.cancel());
    v.classList.remove('is-leaving', 'is-topo');
    v.inert = false;
    v.hidden = v !== entrando && v !== saindo;
  });

  estado.tela = tela;
  entrando.hidden = false;
  if (tela === 'inicio') { estado.diaSel = null; estado.semanaDesl = 0; renderInicio(); }
  if (tela === 'treino') renderTreino();
  if (tela === 'exercicio') renderExercicio();
  if (tela === 'historico') renderHistorico();
  if (tela === 'graficos') renderGraficos();
  atualizarSync();

  const tabbar = $('#tabbar');
  tabbar.classList.toggle('is-off', !ABAS.has(tela));
  tabbar.inert = !ABAS.has(tela);
  tabbar.querySelectorAll('.tab').forEach((b) => {
    if (b.dataset.aba === tela) b.setAttribute('aria-current', 'page');
    else b.removeAttribute('aria-current');
  });

  const lista = listaRolavel(entrando);
  const salvo = voltando ? rolagens[tela] : null;
  entrando.scrollTop = salvo ? salvo.view : 0;
  if (lista) lista.scrollTop = salvo ? salvo.lista : 0;

  if (saindo === entrando) return;
  if (animar && !entreAbas) animarTroca(saindo, entrando, voltando, posicoes);
  else saindo.hidden = true;
}

/* Como no iOS: avançar entra pela direita e voltar sai por onde entrou. A tela nova já
   responde ao toque durante a animação. */
function animarTroca(saindo, entrando, voltando, posicoes) {
  const opcoes = { duration: 300, easing: 'cubic-bezier(0.32, 0.72, 0, 1)' };
  const atras = { transform: 'translateX(-25%)', opacity: 0.5 };
  const fora = { transform: 'translateX(100%)', opacity: 1 };
  const parado = { transform: 'none', opacity: 1 };

  saindo.classList.add('is-leaving');
  saindo.classList.toggle('is-topo', voltando);
  saindo.inert = true;

  const reduzido = matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (reduzido) {
    opcoes.duration = 180;
    opcoes.easing = 'ease';
    entrando.animate([{ opacity: 0 }, { opacity: 1 }], opcoes);
  } else {
    entrando.animate([posicoes.get(entrando) || (voltando ? atras : fora), parado], opcoes);
  }
  const fim = reduzido ? { opacity: 0 } : (voltando ? fora : atras);
  const inicio = reduzido ? { opacity: 1 } : (posicoes.get(saindo) || parado);
  saindo.animate([inicio, fim], opcoes).finished.then(() => {
    saindo.hidden = true;
    saindo.classList.remove('is-leaving', 'is-topo');
    saindo.inert = false;
  }).catch(() => { /* interrompida por outra troca de tela */ });
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
  // Se o próprio navegador já animou o gesto de voltar, não anima de novo.
  const animar = !e.hasUAVisualTransition;
  if ((s.tela === 'treino' && !estado.dia) || (s.tela === 'exercicio' && !estado.exercicio)) {
    mostrar('inicio', { animar });
  } else {
    mostrar(s.tela, { animar });
  }
});

function voltar() {
  if (history.state && history.state.tela !== 'inicio') history.back();
  else mostrar('inicio');
}

function iniciar() {
  // Sem um listener de toque, o Safari do iPhone não aplica :active e os botões não reagem à pressão.
  document.addEventListener('touchstart', () => {}, { passive: true });

  // Navegação
  document.querySelectorAll('.dia-btn').forEach((b) => b.addEventListener('click', () => escolherDia(b.dataset.dia)));
  document.querySelectorAll('[data-back]').forEach((b) => b.addEventListener('click', voltar));
  document.querySelectorAll('.tab').forEach((b) => b.addEventListener('click', () => {
    if (b.dataset.aba === estado.tela) return;
    vibrar(5);
    if (b.dataset.aba === 'inicio') voltar();
    else if (estado.tela === 'inicio') irPara(b.dataset.aba);
    else {
      // Entre abas internas, troca a entrada atual: voltar sempre leva ao início.
      history.replaceState({ tela: b.dataset.aba }, '');
      mostrar(b.dataset.aba);
    }
  }));

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
  ligarArrasteSheet();
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
