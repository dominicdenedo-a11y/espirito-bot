require('dotenv').config();
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const pino = require('pino');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { createClient } = require('@supabase/supabase-js');

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: 'gemini-3.7-flash' });

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);

const http = require('http');
http.createServer((req, res) => { res.writeHead(200); res.end('Bot is running'); }).listen(process.env.PORT || 3000);


const BOT_WHATSAPP_NUMBER = '255773189300';

let currentBusiness = null;

async function loadBusiness() {
  const { data, error } = await supabase
    .from('businesses')
    .select('*')
    .eq('whatsapp_number', BOT_WHATSAPP_NUMBER)
    .single();

  if (error) {
    console.error('Could not load business:', error.message);
    return null;
  }
  return data;
}

async function getProductContext(businessId) {
  const { data, error } = await supabase
    .from('products')
    .select('*')
    .eq('business_id', businessId);

  if (error) {
    console.error('Supabase error:', error.message);
    return { text: 'No product data available.', products: [] };
  }
  if (!data || data.length === 0) return { text: 'No products in stock right now.', products: [] };

  const text = data
    .map(p => `- [${p.id}] ${p.name}: ₦${p.price}, ${p.stock} in stock. ${p.description || ''}${p.image_url ? ' (has a photo available)' : ''}`)
    .join('\n');

  return { text, products: data };
}

async function logDeal(businessId, customerNumber, chatSummary, productId) {
  const { error } = await supabase.from('deals').insert({
    business_id: businessId,
    customer_number: customerNumber,
    product_id: productId || null,
    chat_summary: chatSummary,
    status: 'pending',
  });
  if (error) console.error('Could not log deal:', error.message);
  else console.log('📝 Deal flagged for owner review');
}

async function askGemini(userMessage, businessId) {
  const { text: productContext, products } = await getProductContext(businessId);

  const prompt = `You are a helpful sales assistant for a small business on WhatsApp. Here is the current product list, each with an ID in brackets:

${productContext}

Only answer based on this product list. If asked about something not in the list, say it's not available. Keep replies short and friendly, like a real WhatsApp chat.

Decide three things:
1. Does this customer message sound like they are confirming a purchase (e.g. "I'll take it", "yes I want to order")?
2. Is the customer asking to see what a product looks like (e.g. "send a picture", "show me", "what does it look like")?
3. If either applies, which product ID is it about?

Respond in this exact format:
REPLY: <your reply to the customer>
DEAL: <yes or no>
SEND_IMAGE: <yes or no>
PRODUCT_ID: <the product id if DEAL or SEND_IMAGE is yes and a specific product is clear, otherwise none>

Customer message: ${userMessage}`;

  try {
    const result = await model.generateContent(prompt);
    const raw = result.response.text();

    const replyMatch = raw.match(/REPLY:\s*([\s\S]*?)\nDEAL:/);
    const dealMatch = raw.match(/DEAL:\s*(yes|no)/i);
    const imageMatch = raw.match(/SEND_IMAGE:\s*(yes|no)/i);
    const productMatch = raw.match(/PRODUCT_ID:\s*(\S+)/i);

    const reply = replyMatch ? replyMatch[1].trim() : raw.trim();
    const isDeal = dealMatch && dealMatch[1].toLowerCase() === 'yes';
    const wantsImage = imageMatch && imageMatch[1].toLowerCase() === 'yes';
    const productId = productMatch && productMatch[1] !== 'none' ? productMatch[1] : null;

    const matchedProduct = productId ? products.find(p => p.id === productId) : null;

    return { reply, isDeal, wantsImage, product: matchedProduct };
  } catch (err) {
    console.error('Gemini error:', err.message);
    return { reply: "Sorry, I couldn't process that right now.", isDeal: false, wantsImage: false, product: null };
  }
}

async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState('auth_info');

  const sock = makeWASocket({
    auth: state,
    logger: pino({ level: 'silent' }),
  });

  if (!sock.authState.creds.registered) {
    const phoneNumber = process.env.WHATSAPP_PHONE_NUMBER;
    if (!phoneNumber) { console.error('WHATSAPP_PHONE_NUMBER not set'); return; }
    const code = await sock.requestPairingCode(phoneNumber.trim());
    console.log(`Your pairing code: ${code}`);
  }

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect } = update;
    if (connection === 'close') {
      const shouldReconnect =
        new Boom(lastDisconnect?.error)?.output?.statusCode !== DisconnectReason.loggedOut;
      console.log('Connection closed. Reconnecting:', shouldReconnect);
      if (shouldReconnect) startBot();
    } else if (connection === 'open') {
      console.log('✅ Bot connected to WhatsApp!');
      currentBusiness = await loadBusiness();
      if (currentBusiness) {
        console.log(`🏪 Representing business: ${currentBusiness.name}`);
      } else {
        console.log('⚠️ No business found for this number — deals/products will not work.');
      }
    }
  });

  sock.ev.on('messages.upsert', async ({ messages }) => {
    const msg = messages[0];
    if (!msg.message || msg.key.fromMe) return;
    if (!currentBusiness) return;

    const from = msg.key.remoteJid;
    const text =
      msg.message.conversation ||
      msg.message.extendedTextMessage?.text ||
      '';
    if (!text) return;

    console.log(`📩 Message from ${from}: ${text}`);

    const { reply, isDeal, wantsImage, product } = await askGemini(text, currentBusiness.id);

    console.log(`🤖 Reply: ${reply}`);
    await sock.sendMessage(from, { text: reply });

    if (wantsImage && product && product.image_url) {
      console.log(`🖼️ Sending image for: ${product.name}`);
      try {
        await sock.sendMessage(from, {
          image: { url: product.image_url },
          caption: `${product.name} — ₦${product.price}`,
        });
      } catch (err) {
        console.error('Failed to send image:', err.message);
      }
    }

    if (isDeal) {
      await logDeal(currentBusiness.id, from, text, product ? product.id : null);
    }
  });
}

startBot();
