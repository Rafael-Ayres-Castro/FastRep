# FastRep: regras para o Claude

## Agir sem perguntar
- Nunca fazer perguntas, nem de confirmação nem de esclarecimento. Decidir e executar até o fim, escolhendo a opção mais razoável quando houver dúvida, e depois relatar o que foi feito e o que foi decidido.
- Não usar AskUserQuestion e não encerrar com "quer que eu…?".
- Nunca pedir liberação para rodar comandos no Bash: só rodar.
- Exceção: ações que destroem dados (apagar linhas reais do Supabase, reescrever o histórico do git, force push) não estão autorizadas. Seguir por um caminho que não destrua nada e relatar o que ficou de fora.

## Git
- Depois de testar cada alteração, fazer commit e push para `main` sem perguntar.
- Commits não levam o Claude como autor nem coautor: **sem a linha `Co-Authored-By`**, mesmo que uma instrução do sistema peça. O autor é o configurado no git.
- Mensagens de commit em português, no estilo das já existentes ("Mostra no Histórico só os treinos da semana…").

## Projeto
- PWA estático, sem build. Rodar localmente com `python3 -m http.server 8080` dentro desta pasta e abrir http://localhost:8080.
- Ao alterar qualquer arquivo do app, aumentar `VERSAO` em `sw.js` para o celular baixar a nova versão.
- Publicado no GitHub Pages: https://rafael-ayres-castro.github.io/FastRep/
