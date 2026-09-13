# Checkout backend (Adex + UTMify) — Mini Bike Ergométrica Sênior

Backend Pix dedicado a uma oferta/funil. Migrado da OnyxPag pra **Adex**
(gateway trocado, lógica de UTMify 100% preservada).

## Estado atual desta configuração

| item | valor |
|---|---|
| Repo GitHub | `ballinbsn/api-mini-bike` (branch `main`, auto-deploy ligado) |
| Railway | projeto `precious-recreation` → serviço `api-mini-bike` |
| Domínio | `https://api-mini-bike-production.up.railway.app` (porta 8080) |
| Webhook | `https://api-mini-bike-production.up.railway.app/api/webhooks/adex` |
| Front | `https://mini-bike.vercel.app/` |

**Variáveis a configurar no Railway** (aba Variables) — as `ONYXPAG_*` antigas
não são mais usadas, criar/trocar por:

- `ADEX_PUBLIC_KEY` (painel Adex → Chaves de API)
- `ADEX_SECRET_KEY` (painel Adex → Chaves de API — também valida a assinatura do webhook)
- `ADEX_WEBHOOK_URL` = `https://api-mini-bike-production.up.railway.app/api/webhooks/adex`
- `UTMIFY_API_TOKEN` (mantém o que já estava — não muda com a troca de gateway)
- `PORT=8080` (mantém)

⚠️ **Se você conectar a integração nativa UTMify dentro do painel da Adex**
(Integrações → UTMify), **desative** essa integração nativa ou remova
`UTMIFY_API_TOKEN` daqui — rodando as duas juntas, a mesma venda é reportada
**duas vezes** pra UTMify com order-ids diferentes (conta como 2 vendas na campanha).

## O que mudou na migração

| | OnyxPag (antes) | Adex (agora) |
|---|---|---|
| Auth | Basic (base64 chave pública:privada) | headers `x-public-key` + `x-secret-key` |
| Criar Pix | `POST https://api.onyxpag.com` | `POST https://api.adex.cash/functions/v1/pix-receive` |
| Consultar status | `GET /transactions/{id}` (path) | `GET /pix-receive?transaction_id={id}` (query) |
| Religar pedido pago | `external_ref`/`external_id` ecoado pela gateway | **não dá** — a Adex ignora nosso `external_id` e devolve um UUID dela própria. Religação é só pelo `tx.id` que ELA gera na criação, guardado em `ordersByTxId` |
| Assinatura de webhook | nenhuma documentada | HMAC-SHA256 (`x-webhook-signature: sha256=<hex>`), validada com `crypto.timingSafeEqual` — mas mesmo assinado, o webhook só dispara uma reconsulta, nunca decide sozinho |
| QR Code pronto (imagem) | às vezes vinha (`pix_qr_code`) | nunca vem — só o copia-e-cola (`pix.copyPaste`). O front já sabe gerar a imagem a partir do código, nada muda lá |
| `amount` | reais decimal; `items[].unitPrice` em **centavos** (inconsistente) | reais decimal em ambos (a confirmar no teste de R$1 — ver abaixo) |

## ⚠️ Debug temporário ainda no código

`server.js` tem 3 `console.log` marcados `// TEMP` que imprimem a resposta
crua da Adex (criação, consulta de status, webhook). Ficam até o teste de
R$1 confirmar que o parsing (`body.transaction`, `body.pix.copyPaste`,
`body.pix.expiresAt`) bate com a resposta real — a doc da Adex já se mostrou
inconsistente com o comportamento real em outro projeto, então não dá pra
confiar sem testar. **Remover depois de confirmado.**

| Method | Route | Uso |
|---|---|---|
| POST | /api/pay | cria a cobrança Pix |
| GET | /api/pix-status?id= | consulta o status do pagamento (fonte de verdade) |
| POST | /api/webhooks/adex | webhook da Adex — valida assinatura, mas sempre reconsulta antes de confiar |
| GET | /health | healthcheck |

## Rodar localmente

```
npm install
cp .env.example .env   # preencha com suas próprias chaves, nunca comite o .env
npm run dev
```

## Deploy

1. Repositório próprio e **privado** no GitHub (não junte com o site) — use
   `git push`, não a interface web do GitHub (ela trava em arquivos grandes).
2. Railway → New Project → Deploy from repo (Nixpacks detecta Node sozinho).
3. Railway → Variables → cole as variáveis do `.env.example` com os valores reais.
4. Railway → Settings → Networking → Generate Domain.
5. Confirme com `curl https://SEU-DOMINIO/health` → `{"ok":true}`.
6. Preencha `ADEX_WEBHOOK_URL` com esse domínio + `/api/webhooks/adex` e salve (redeploy automático).
7. Se a Adex tiver um cadastro de webhook separado no painel dela, registre essa mesma URL lá.
8. No front-end, `BACKEND_URL` já aponta pra esse domínio do Railway — não muda com a troca de gateway.
