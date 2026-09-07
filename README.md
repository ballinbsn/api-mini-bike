# Checkout backend (OnyxPag + UTMify) — Mini Bike Ergométrica Sênior

Backend Pix dedicado a uma oferta/funil. Veja o skill `onyxpag-utmify-checkout`
pro playbook completo (gotchas, debugging, onde achar cada credencial).

## Estado atual desta configuração

| item | valor |
|---|---|
| Repo GitHub | `ballinbsn/api-mini-bike` (branch `main`, auto-deploy ligado) |
| Railway | projeto `precious-recreation` → serviço `api-mini-bike` |
| Domínio | `https://api-mini-bike-production.up.railway.app` (porta 8080) |
| Webhook | `https://api-mini-bike-production.up.railway.app/api/webhooks/onyxpag` |

**Já criados no Railway** (aba Variables): `ONYXPAG_WEBHOOK_URL`, `PORT=8080` e os
3 placeholders abaixo — **você só precisa colar os valores reais neles:**

- `ONYXPAG_PUBLIC_KEY`  → hoje `COLE_AQUI_SUA_CHAVE_PUBLICA_ONYXPAG`
- `ONYXPAG_PRIVATE_KEY` → hoje `COLE_AQUI_SUA_CHAVE_PRIVADA_ONYXPAG`
- `UTMIFY_API_TOKEN`    → hoje `COLE_AQUI_SEU_TOKEN_UTMIFY`

**Falta:**
1. `git push` deste código para `ballinbsn/api-mini-bike` (o commit já está pronto aqui).
2. Colar os 3 valores reais nas variáveis acima (Railway → api-mini-bike → Variables → clicar em cada uma → editar).
3. Cadastrar `https://api-mini-bike-production.up.railway.app/api/webhooks/onyxpag`
   no painel da OnyxPag (aba Webhooks) também.
4. (Opcional) criar `CORS_ORIGIN` com o domínio da landing quando ela estiver publicada.

Depois disso: `curl https://api-mini-bike-production.up.railway.app/health` deve
devolver `{"ok":true}`. O front (`assets/js/checkout.js`) já aponta para esse domínio.

| Method | Route | Uso |
|---|---|---|
| POST | /api/pay | cria a cobrança Pix |
| GET | /api/pix-status?id= | consulta o status do pagamento (fonte de verdade) |
| POST | /api/webhooks/onyxpag | webhook da OnyxPag — só um aviso, sempre reconsulta antes de confiar |
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
6. Preencha `ONYXPAG_WEBHOOK_URL` com esse domínio + `/api/webhooks/onyxpag` e salve (redeploy automático).
7. Se a OnyxPag tiver um cadastro de webhook separado no painel dela, registre essa mesma URL lá.
8. No front-end, aponte `BACKEND_URL` pra esse domínio do Railway.
