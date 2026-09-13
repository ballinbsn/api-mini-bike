import "dotenv/config";
import express from "express";
import cors from "cors";
import crypto from "crypto";

const app = express();
const PORT = process.env.PORT || 3000;
const ADEX_BASE = "https://api.adex.cash/functions/v1";
const UTMIFY_ORDERS_URL = "https://api.utmify.com.br/api-credentials/orders";

// CORS_ORIGIN: domínio(s) que podem chamar essa API, separados por vírgula.
// Sem isso, libera geral (funciona, mas é menos seguro).
const allowedOrigins = (process.env.CORS_ORIGIN || "").split(",").map((s) => s.trim()).filter(Boolean);
app.use(cors({ origin: allowedOrigins.length ? allowedOrigins : true }));
app.use(express.json());

function onlyDigits(value) {
  return String(value || "").replace(/\D/g, "");
}

function clientIp(req) {
  const fwd = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim();
  return fwd || req.socket?.remoteAddress || null;
}

// Data no formato que a UTMify exige: "YYYY-MM-DD HH:MM:SS" em UTC.
function utmifyDate(d = new Date()) {
  return d.toISOString().slice(0, 19).replace("T", " ");
}

// Gera um CPF com dígitos verificadores válidos — fallback quando o front não
// mandou um CPF válido (não deveria acontecer: a tela pede e valida antes).
function genCPF() {
  const n = [];
  for (let i = 0; i < 9; i++) n.push(Math.floor(Math.random() * 9));
  for (let j = 0; j < 2; j++) {
    let s = 0;
    const w = n.length + 1;
    for (let k = 0; k < n.length; k++) s += n[k] * (w - k);
    const r = 11 - (s % 11);
    n.push(r >= 10 ? 0 : r);
  }
  return n.join("");
}

// Telefone celular BR aleatório e plausível (DDD + 9 + 8 dígitos).
function genPhone() {
  const ddds = ["11", "21", "31", "41", "51", "61", "71", "81", "85", "19", "27", "48", "62", "98"];
  const ddd = ddds[Math.floor(Math.random() * ddds.length)];
  let num = "9";
  for (let i = 0; i < 8; i++) num += Math.floor(Math.random() * 10);
  return ddd + num;
}

// Auth da Adex: dois headers, não é Basic/Bearer.
function adexAuthHeaders() {
  return {
    "x-public-key": process.env.ADEX_PUBLIC_KEY || "",
    "x-secret-key": process.env.ADEX_SECRET_KEY || "",
  };
}

/* ================================================================== */
/* UTMify — envio de pedidos (rastreio de venda + conversão pro Meta).
   1 pedido é enviado em "waiting_payment" quando o Pix é gerado e
   atualizado pro status final ("paid" / "refused") usando o MESMO
   orderId. A UTMify só dispara Purchase pro Meta no "paid".

   O pedido fica guardado em memória por 24h, indexado pelo nosso orderId
   (prefixo "MBS" = Mini Bike Sênior). A Adex IGNORA o external_id que a
   gente manda na criação e devolve o dela própria (um UUID aleatório) —
   então, diferente da OnyxPag, não dá pra religar a transação ao pedido
   por nenhum campo que a Adex devolva. A única religação confiável é pelo
   ID DA TRANSAÇÃO QUE A PRÓPRIA ADEX GERA na criação (tx.id), guardado
   aqui em ordersByTxId. */
const PAID_STATUSES = new Set(["pago", "paid", "aprovado", "approved", "completed", "concluido", "concluído"]);
const FAILED_STATUSES = new Set(["expirado", "expired", "cancelado", "canceled", "cancelled", "failed"]);
const ordersById = new Map();   // orderId (MBS...)            -> rec
const ordersByTxId = new Map(); // transactionId (da Adex)     -> rec

setInterval(() => {
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  for (const [k, v] of ordersById) if ((v.ts || 0) < cutoff) ordersById.delete(k);
  for (const [k, v] of ordersByTxId) if ((v.ts || 0) < cutoff) ordersByTxId.delete(k);
}, 60 * 60 * 1000).unref?.();

async function sendUtmifyOrder(rec, status, approvedDate = null) {
  if (!process.env.UTMIFY_API_TOKEN) return;
  if (!rec || !rec.orderId) return;
  rec.utmifySent = rec.utmifySent || new Set();
  if (rec.utmifySent.has(status)) return;
  rec.utmifySent.add(status);

  const t = rec.tracking || {};
  const payload = {
    orderId: rec.orderId,
    platform: "Adex",
    paymentMethod: "pix",
    status,
    createdAt: rec.createdAt || utmifyDate(),
    approvedDate: approvedDate || (status === "paid" ? utmifyDate() : null),
    refundedAt: status === "refunded" ? utmifyDate() : null,
    customer: {
      name: rec.customer?.name || "",
      email: rec.customer?.email || "",
      phone: rec.customer?.phone || null,
      document: rec.customer?.document || null,
      country: "BR",
      ip: rec.customer?.ip || null,
    },
    products: [
      {
        id: "mini-bike-ergometrica-senior",
        name: rec.product || "Mini Bike Ergométrica Sênior",
        planId: null,
        planName: null,
        quantity: 1,
        priceInCents: rec.amountCents,
      },
    ],
    trackingParameters: {
      src: t.src || null,
      sck: t.sck || null,
      utm_source: t.utm_source || null,
      utm_campaign: t.utm_campaign || null,
      utm_medium: t.utm_medium || null,
      utm_content: t.utm_content || null,
      utm_term: t.utm_term || null,
    },
    commission: {
      totalPriceInCents: rec.amountCents,
      gatewayFeeInCents: 0,
      userCommissionInCents: rec.amountCents,
      currency: "BRL",
    },
    isTest: false,
  };

  try {
    const r = await fetch(UTMIFY_ORDERS_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-token": process.env.UTMIFY_API_TOKEN },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(10_000),
    });
    if (!r.ok) {
      rec.utmifySent.delete(status);
      const errText = await r.text().catch(() => "");
      console.error("[utmify] pedido falhou", status, rec.orderId, r.status, errText);
      return { ok: false, httpStatus: r.status, body: errText };
    }
    console.log("[utmify] pedido enviado", status, rec.orderId);
    return { ok: true };
  } catch (e) {
    rec.utmifySent.delete(status);
    console.error("[utmify] exceção ao enviar pedido", e.message);
    return { ok: false, error: e.message };
  }
}

// Consulta a transação DIRETO na Adex, com nossas próprias credenciais.
// É a única fonte de verdade sobre status de pagamento — o webhook (abaixo)
// só dispara essa consulta em vez de ser confiado diretamente, mesmo tendo
// assinatura válida. Retorna null se não achar/erro.
async function fetchAdexTransaction(transactionId) {
  const r = await fetch(`${ADEX_BASE}/pix-receive?transaction_id=${encodeURIComponent(transactionId)}`, {
    headers: adexAuthHeaders(),
    signal: AbortSignal.timeout(10_000),
  });
  const body = await r.json().catch(() => null);
  console.log("[adex] DEBUG resposta bruta da consulta de status:", JSON.stringify(body).slice(0, 800)); // TEMP — remover após validar no teste de R$1
  if (!r.ok || !body?.transaction) {
    console.error("[adex] falha ao consultar transação", transactionId, r.status, JSON.stringify(body).slice(0, 500));
    return null;
  }
  return body.transaction;
}

// Depois de confirmar (via fetchAdexTransaction) que uma transação está paga
// de verdade, avisa a UTMify. NÃO usamos tx.external_ref/tx.external_id pra
// religar — pra Adex isso é o UUID aleatório dela própria, não o nosso
// orderId (ver comentário lá em cima). Só o hint explícito (quando temos) ou
// o índice por tx.id servem de religação confiável.
async function handleConfirmedStatus(tx, hintOrderId = null) {
  if (!tx) return;
  const orderId = hintOrderId || null;
  let rec = (orderId && ordersById.get(orderId)) || (tx.id && ordersByTxId.get(tx.id)) || null;
  if (!rec && orderId) {
    // Só acontece se o processo reiniciou e perdemos o índice em memória —
    // reconstrói com o que a Adex devolveu, pra não deixar de reportar a venda.
    rec = {
      orderId,
      createdAt: tx.created_at || utmifyDate(),
      ts: Date.now(),
      product: "Mini Bike Ergométrica Sênior",
      amountCents: Math.round(parseFloat(tx.amount || "0") * 100),
      customer: { name: "", email: "", phone: null, document: null, ip: null },
      tracking: {},
      utmifySent: new Set(),
    };
    ordersById.set(orderId, rec);
  }
  if (!rec) {
    console.warn("[adex] status confirmado sem conseguir religar ao pedido (tx.id não está em ordersByTxId — provável restart)", tx.id);
    return;
  }

  const status = String(tx.status || "").toLowerCase();
  if (PAID_STATUSES.has(status)) {
    await sendUtmifyOrder(rec, "paid", utmifyDate());
  } else if (FAILED_STATUSES.has(status)) {
    await sendUtmifyOrder(rec, "refused");
  }
}

// Valida a assinatura HMAC-SHA256 do webhook da Adex:
// header "x-webhook-signature: sha256=<hex>", calculada sobre
// JSON.stringify(req.body) usando ADEX_SECRET_KEY.
function verifyAdexSignature(req) {
  const header = String(req.headers["x-webhook-signature"] || "");
  const match = header.match(/^sha256=([0-9a-f]+)$/i);
  if (!match || !process.env.ADEX_SECRET_KEY) return false;
  try {
    const expected = crypto
      .createHmac("sha256", process.env.ADEX_SECRET_KEY)
      .update(JSON.stringify(req.body))
      .digest("hex");
    const a = Buffer.from(match[1].toLowerCase(), "hex");
    const b = Buffer.from(expected, "hex");
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

// Webhook da Adex. Mesmo com assinatura válida, ele NUNCA decide status
// sozinho — só dispara a consulta autenticada acima, que é quem manda.
// Payload exato ainda não 100% confirmado (a doc não é confiável) — por
// isso tenta vários caminhos pro id da transação e loga o corpo cru.
app.post("/api/webhooks/adex", async (req, res) => {
  res.status(200).end(); // responde rápido; processa depois

  const validSig = verifyAdexSignature(req);
  console.log("[adex webhook] recebido", { validSig, hasSecret: !!process.env.ADEX_SECRET_KEY });
  console.log("[adex webhook] DEBUG corpo cru:", JSON.stringify(req.body).slice(0, 800)); // TEMP — remover após validar no teste de R$1
  if (!validSig) {
    console.warn("[adex webhook] assinatura ausente/inválida — ignorando (nada é decidido só pelo webhook mesmo)");
    return;
  }

  const data = req.body || {};
  const transactionId = data?.transaction?.id || data?.data?.id || data?.id || data?.transaction_id || null;
  if (!transactionId) {
    console.warn("[adex webhook] não achou id de transação no payload, ignorando");
    return;
  }

  const tx = await fetchAdexTransaction(transactionId);
  if (!tx) {
    console.warn("[adex webhook] não confirmou a transação na consulta, ignorando", transactionId);
    return;
  }
  await handleConfirmedStatus(tx);
});

// Cria a cobrança Pix pro pedido
app.post("/api/pay", async (req, res) => {
  if (!process.env.ADEX_PUBLIC_KEY || !process.env.ADEX_SECRET_KEY) {
    console.error("[adex] ADEX_PUBLIC_KEY/ADEX_SECRET_KEY não configurados no ambiente");
    return res.status(500).json({ error: "server_misconfigured" });
  }

  const { product, amountReais, customer, address, tracking } = req.body || {};

  const amountCents = Math.round(Number(amountReais) * 100);
  if (!Number.isInteger(amountCents) || amountCents < 100) return res.status(400).json({ error: "amount_invalid" });
  if (!product || typeof product !== "string") return res.status(400).json({ error: "product_invalid" });

  let cpf = onlyDigits(customer?.cpf);
  if (cpf.length !== 11) cpf = genCPF();
  let phone = onlyDigits(customer?.phone);
  if (phone.length < 10 || phone.length > 11) phone = genPhone();
  const email = String(customer?.email || "").trim();
  const name = String(customer?.name || "").trim();
  if (!name || name.length < 2 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: "customer_invalid" });
  }
  // Endereço só é obrigatório pra ofertas físicas — remova este bloco se a
  // oferta for digital e o front não coletar endereço nenhum.
  if (!address?.cep || !address?.cidade || !address?.uf) {
    return res.status(400).json({ error: "address_invalid" });
  }

  const orderId = "MBS" + Date.now() + Math.random().toString(36).slice(2, 7);
  const createdAt = utmifyDate();
  const ip = clientIp(req);
  const t = tracking || {};

  try {
    const r = await fetch(`${ADEX_BASE}/pix-receive`, {
      method: "POST",
      headers: {
        ...adexAuthHeaders(),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        // Valor total em REAIS (decimal) — confirmado que a Adex usa reais
        // aqui de verdade, apesar da tabela de parâmetros da doc dizer
        // "centavos". items[].unitPrice abaixo segue a mesma convenção
        // (reais) por ora — CONFERIR no teste de R$1: se a Adex devolver
        // fee_amount/net_amount muito diferentes do esperado, é sinal de
        // que unitPrice precisa ser centavos. O valor cobrado de fato é
        // sempre o campo "amount" top-level, então mesmo se isso estiver
        // errado o cliente não é cobrado errado — só o item fica com
        // descrição errada no painel da Adex.
        amount: Number((amountCents / 100).toFixed(2)),
        paymentMethod: "pix",
        customer: {
          name,
          email,
          phone,
          document: { number: cpf, type: "cpf" },
          address: {
            zip: onlyDigits(address.cep),
            street: address.rua || "",
            number: address.numero || "s/n",
            complement: address.complemento || "",
            neighborhood: address.bairro || "",
            city: address.cidade || "",
            state: address.uf || "",
          },
        },
        items: [
          {
            title: product,
            unitPrice: Number((amountCents / 100).toFixed(2)),
            quantity: 1,
            tangible: true, // false para produto digital
          },
        ],
        postbackUrl: process.env.ADEX_WEBHOOK_URL,
        // A Adex ignora isso e devolve um UUID próprio — mandamos mesmo
        // assim só por clareza/log do lado dela; a religação real é feita
        // por ordersByTxId (ver comentário lá em cima).
        external_id: orderId,
      }),
      signal: AbortSignal.timeout(30_000),
    });

    const body = await r.json().catch(() => ({}));
    console.log("[adex] DEBUG resposta completa da criação:", JSON.stringify(body).slice(0, 1200)); // TEMP — remover após validar no teste de R$1

    if (!r.ok || !body?.transaction || !body?.pix) {
      console.error("[adex] falha ao criar cobrança", r.status, JSON.stringify(body).slice(0, 800));
      return res.status(502).json({ error: "gateway_error" });
    }

    const tx = body.transaction;
    const pix = body.pix;
    console.log("[adex] cobrança criada", { orderId, transactionId: tx.id, status: tx.status });

    // Endereço de entrega fica só com a gente — a Adex não devolve isso pra
    // gente reconsultar depois, mas precisamos guardar pra despachar o produto.
    const enderecoResumo = address
      ? `${address.rua || ""}, ${address.numero || "s/n"}` +
        (address.complemento ? ` - ${address.complemento}` : "") +
        (address.bairro ? ` - ${address.bairro}` : "") +
        `, ${address.cidade}/${address.uf} - CEP ${onlyDigits(address.cep)}`
      : null;

    const rec = {
      orderId,
      createdAt,
      ts: Date.now(),
      product,
      amountCents,
      customer: { name, email, phone, document: cpf, ip },
      endereco: enderecoResumo,
      tracking: {
        src: t.src || null,
        sck: t.sck || null,
        utm_source: t.utm_source || null,
        utm_campaign: t.utm_campaign || null,
        utm_medium: t.utm_medium || null,
        utm_content: t.utm_content || null,
        utm_term: t.utm_term || null,
      },
      txId: tx.id,
      utmifySent: new Set(),
    };
    ordersById.set(orderId, rec);
    ordersByTxId.set(tx.id, rec);

    sendUtmifyOrder(rec, "waiting_payment").catch(() => {});

    // Formato normalizado que o front já espera — não muda com a troca de gateway.
    // A Adex não devolve imagem de QR pronta, só o copia-e-cola (o front já
    // sabe gerar o QR a partir disso).
    return res.status(201).json({
      pix_id: tx.id,
      qr_code: pix.copyPaste,
      qr_code_image: null,
      expires_at: pix.expiresAt,
      order_id: orderId,
    });
  } catch (e) {
    console.error("[adex] exceção ao criar cobrança", e);
    return res.status(500).json({ error: "internal" });
  }
});

// O frontend consulta esse endpoint a cada poucos segundos. É a fonte de
// verdade principal (webhook só complementa, nunca decide sozinho).
// Aceita ?id=<transaction id, o mesmo "pix_id" devolvido por /api/pay>.
app.get("/api/pix-status", async (req, res) => {
  if (!process.env.ADEX_PUBLIC_KEY || !process.env.ADEX_SECRET_KEY) {
    console.error("[adex] ADEX_PUBLIC_KEY/ADEX_SECRET_KEY não configurados no ambiente");
    return res.status(500).json({ error: "server_misconfigured" });
  }

  const id = typeof req.query?.id === "string" ? req.query.id : "";
  if (!/^[A-Za-z0-9_-]+$/.test(id)) return res.status(400).json({ error: "id_invalid" });

  try {
    const tx = await fetchAdexTransaction(id);
    if (!tx) return res.status(200).json({ status: "pending", expires_at: null });

    await handleConfirmedStatus(tx);

    return res.status(200).json({ status: tx.status, expires_at: tx.expires_at ?? null });
  } catch (e) {
    console.error("[adex] exceção ao consultar status", e);
    return res.status(500).json({ error: "internal" });
  }
});

app.get("/health", (req, res) => res.json({ ok: true }));

app.listen(PORT, () => {
  console.log(`Backend Pix Mini Bike Ergométrica Sênior (Adex + UTMify) rodando na porta ${PORT}`);
  if (!process.env.ADEX_PUBLIC_KEY || !process.env.ADEX_SECRET_KEY) {
    console.warn("⚠️  ADEX_PUBLIC_KEY / ADEX_SECRET_KEY não configurados.");
  }
  if (!process.env.ADEX_SECRET_KEY) {
    console.warn("⚠️  Sem ADEX_SECRET_KEY, a assinatura do webhook não pode ser validada — todo webhook será ignorado (o polling continua funcionando normalmente).");
  }
  if (!process.env.UTMIFY_API_TOKEN) console.warn("⚠️  UTMIFY_API_TOKEN não configurado — vendas não vão pra UTMify.");
});
