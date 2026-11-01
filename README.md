# FastRep — registro rápido de treino (PWA)

Arquivos: `index.html`, `style.css`, `app.js`, `manifest.json`, `sw.js`, `icons/`, `vendor/` (SDK do Supabase 2.45.4, embutido para funcionar offline), `fonts/` (Barlow Condensed, licença OFL, embutida para funcionar offline).

## Rodar
Precisa ser servido por HTTP(S) (service worker não funciona abrindo o arquivo direto):

    python3 -m http.server 8080

No iPhone, publique em qualquer host HTTPS estático (GitHub Pages, Netlify, Vercel), abra no Safari → Compartilhar → "Adicionar à Tela de Início".

## Trocar localStorage pelo Supabase
Tudo que fala com o "servidor" está em duas funções no topo do `app.js`:
`salvarSerie(serie)` e `removerSerie(id)`. Troque o corpo delas pelos exemplos que estão nos comentários.
O resto (fila offline, status "Salvo / Sem conexão") continua igual: se a função lançar erro, a série fica na fila e é reenviada quando a conexão voltar.

Tabela sugerida:

```sql
create table series (
  id            uuid primary key,
  criado_em     timestamptz not null default now(),
  dia_treino    text not null check (dia_treino in ('A','B','C','D')),
  exercicio     text not null,
  numero_serie  integer not null,
  repeticoes    integer not null,
  carga_kg      numeric
);
```

Tabela `exercicios` (lista de cada treino e padrões, compartilhados entre aparelhos):

```sql
create table exercicios (
  nome          text primary key,
  dias          text[] not null default '{}',
  reps_padrao   integer,
  carga_padrao  numeric,
  criado_em     timestamptz not null default now()
);
```

Ao alterar arquivos, aumente `VERSAO` em `sw.js` para o app atualizar no celular.
# FastRep
