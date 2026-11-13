# Antigravity Account Ledger

Acompanhe o uso de tokens do Antigravity (modelos Gemini e Claude/GPT) e o detalhamento de custos em USD por conta do Google e intervalo de datas personalizado no Token Monitor, com atribuição automática entre várias contas.

## Compatibilidade e instalação

Requer o Token Monitor **0.81.0 ou superior**. O Token Monitor 0.80.0 não inclui o runtime de plugins e recusa a instalação. No 0.81.0 ou superior, instale diretamente pelo diretório integrado **Token Monitor Community** ou importe a pasta do plugin / pacote `.tmplugin` em **Configurações → Plugins → Instalar de arquivo**, revise e ative.

Testes de plataforma: validado no Windows com o Token Monitor 0.81.0; macOS e Linux passam nos contratos do Node e nos testes unitários, com a GUI de desktop aguardando validação real.

## Recursos

- **Atribuição automática entre contas**: detecta a conta Google ativa a partir do estado local do Antigravity e atribui o uso pela linha do tempo de heartbeat da conta ativa, pelas janelas locais de redefinição de cota e por âncoras de logs da CLI/ferramentas. Registros sem correspondência ficam em um bucket não atribuído separado.
- **Cobertura completa de modelos**: acompanha modelos Gemini e não Gemini, como Claude Sonnet/Opus e GPT, separando os pools de cota Gemini, Claude/GPT e Gemini 4 Argon.
- **Intervalo de datas e filtro de conta personalizados**: consulte tokens de entrada, saída, leitura de cache e raciocínio, além do custo estimado em USD, para qualquer janela `YYYY-MM-DD ~ YYYY-MM-DD` e conta Google individual.
- **Visualização Home independente**: renderiza seu próprio cabeçalho e controle de recolhimento dentro do módulo, sem modificar o layout Home do host, e inclui uma tabela opcional de comparação de uso por conta.

## Dados e privacidade

O plugin acessa somente as seguintes fontes locais, em modo leitura: bancos SQLite de conversas do Antigravity em `~/.gemini/`, `state.vscdb` do Antigravity, `~/.antigravity_tools` e os arquivos locais de credenciais OAuth `jetski-standalone-oauth-token`, `antigravity-oauth-token` e `oauth_creds.json` — os arquivos de credenciais são usados apenas localmente para extrair o e-mail da conta. Todos os dados são lidos e persistidos localmente. Nenhuma credencial, token ou registro de uso é transmitido para qualquer rede externa.

## Licença

[MIT](LICENSE) · [Changelog](CHANGELOG.pt-BR.md) · [Todos os plugins](../../README.pt-BR.md)
