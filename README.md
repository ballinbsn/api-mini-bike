# Checkout backend (OnyxPag + UTMify)

Backend Pix dedicado a uma oferta/funil. Veja o skill `onyxpag-utmify-checkout`
pro playbook completo (gotchas, debugging, onde achar cada credencial).

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
