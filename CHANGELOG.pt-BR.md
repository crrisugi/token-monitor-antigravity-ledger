# Changelog

## 0.2.1

Declara suporte a execução em segundo plano (`"background": true`) para que o Token Monitor continue registrando trocas de conta e deltas de uso mesmo com a janela principal minimizada ou fechada, exibe um aviso discreto quando o modo em segundo plano está desativado e preserva a atribuição em pausas curtas da mesma conta (até 2 horas sem atividade de outra conta).

## 0.2.0

Migra para arquitetura host-first usando `data.query` do Token Monitor (`tools`, `models`, `history` e `limits`) para uso e custos: remove a varredura própria de SQLite/Protobuf, tabelas de preços fixas e heurísticas falhas de cota. Adota atribuição em tempo real por delta diário resistente a reinicializações, detecção de conta ativa por RPC do host e `app_storage.json` do Antigravity 2.0 por recência, além de sincronização leve em segundo plano com proteção contra lacunas offline.

## 0.1.0

Lançamento inicial: registro de uso de tokens do Antigravity por conta Google (modelos Gemini e Claude/GPT), com atribuição automática entre contas pela linha do tempo de heartbeat e por âncoras locais de cota/logs, filtro por intervalo de datas personalizado e por conta, e uma visualização recolhível independente na página inicial.
