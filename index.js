const express = require('express');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { createClient } = require('@supabase/supabase-js');
const dotenv = require('dotenv');
const cors = require('cors');

dotenv.config();

const app = express();
const port = process.env.PORT || 3000;

// Initialize Supabase Admin
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

app.use(express.json()); // For regular json endpoints
app.use(cors());

// NEW: Endpoint to create a checkout session
app.post('/create-checkout-session', async (req, res) => {
  const { event_id, user_id, amount, title } = req.body;

  try {
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: [
        {
          price_data: {
            currency: 'inr',
            product_data: {
              name: title,
            },
            unit_amount: amount * 100, // Stripe expects amounts in cents
          },
          quantity: 1,
        },
      ],
      mode: 'payment',
      success_url: 'https://hushh.vercel.app/success', // Your app's success page or redirect
      cancel_url: 'https://hushh.vercel.app/cancel',
      metadata: {
        event_id,
        user_id,
      },
    });

    res.json({ url: session.url });
  } catch (error) {
    console.error(`Stripe Error: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

// Stripe Webhook Endpoint (Requires raw body for signature verification)
app.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];

  let event;

  try {
    event = stripe.webhooks.constructEvent(
      req.body,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    console.error(`Webhook Error: ${err.message}`);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  // Handle the event
  switch (event.type) {
    case 'checkout.session.completed':
      const session = event.data.object;
      await handleSuccessfulPayment(session);
      break;
    default:
      console.log(`Unhandled event type ${event.type}`);
  }

  res.json({ received: true });
});

async function handleSuccessfulPayment(session) {
  const { event_id, user_id } = session.metadata;

  if (!event_id || !user_id) {
    console.error('Missing metadata in Stripe session');
    return;
  }

  console.log(`Processing payment for Event: ${event_id}, User: ${user_id}`);

  // Update payment status in Supabase
  const { data, error } = await supabase
    .from('event_registrations')
    .update({ payment_status: 'paid' })
    .match({ event_id, user_id });

  if (error) {
    console.error(`Error updating Supabase: ${error.message}`);
  } else {
    console.log('Payment status updated successfully in Supabase');
  }
}

app.listen(port, () => {
  console.log(`Stripe Webhook Server running on port ${port}`);
});
