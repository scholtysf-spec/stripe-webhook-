require('dotenv').config();
const express = require('express');
const admin = require('firebase-admin');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

admin.initializeApp({
  projectId: 'arbeitsbuch-app'
});

const app = express();
app.use(express.raw({type: 'application/json'}));

const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;
app.post('/webhook', async (req, res) => {
    const sig = req.headers['stripe-signature'];
    let event;

    try {
        event = stripe.webhooks.constructEvent(
            req.body,
            sig,
            STRIPE_WEBHOOK_SECRET
        );
    } catch (err) {
        console.error('❌ Webhook Fehler:', err.message);
        return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    const db = admin.firestore();

    switch (event.type) {
        case 'customer.subscription.created':
        case 'customer.subscription.updated':
        case 'invoice.payment_succeeded': {
            const subscription = event.data.object;
            const customerId = subscription.customer;
            
            try {
                const customer = await stripe.customers.retrieve(customerId);
                const email = customer.email;
                if (!email) {
                    console.log('Keine Email gefunden');
                    return res.json({ received: true });
                }

                const userRecord = await admin.auth().getUserByEmail(email);
                const uid = userRecord.uid;

                let type = 'monthly';
                let expiresAt = new Date();
                
                if (subscription.items?.data?.[0]?.plan?.interval === 'year') {
                    type = 'yearly';
                }
                
                expiresAt.setDate(expiresAt.getDate() + (type === 'yearly' ? 365 : 30));

                await db.doc(`users/${uid}/subscription/status`).set({
                    type,
                    expiresAt: expiresAt.toISOString(),
                    stripeCustomerId: customerId,
                    stripeSubscriptionId: subscription.id,
                    updatedAt: admin.firestore.FieldValue.serverTimestamp()
                }, { merge: true });

                console.log(`✅ Abo aktiviert für ${email} (${type})`);
                res.json({ received: true });
            } catch (err) {
                console.error('❌ Fehler beim Aktivieren:', err.message);
                res.json({ received: true });
            }
            break;
        }

        case 'customer.subscription.deleted':
        case 'invoice.payment_failed': {
            const subscription = event.data.object;
            const customerId = subscription.customer;
            
            try {
                const customer = await stripe.customers.retrieve(customerId);
                const email = customer.email;
                if (!email) {
                    return res.json({ received: true });
                }

                const userRecord = await admin.auth().getUserByEmail(email);
                const uid = userRecord.uid;

                await db.doc(`users/${uid}/subscription/status`).set({
                    type: 'expired',
                    expiresAt: new Date().toISOString(),
                    updatedAt: admin.firestore.FieldValue.serverTimestamp()
                }, { merge: true });

                console.log(`❌ Abo deaktiviert für ${email}`);
                res.json({ received: true });
            } catch (err) {
                console.error('❌ Fehler beim Deaktivieren:', err.message);
                res.json({ received: true });
            }
            break;
        }

        default:
            console.log(`📨 Event: ${event.type}`);
            res.json({ received: true });
    }
});

app.get('/', (req, res) => {
    res.send('Webhook Server läuft ✅');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 Server läuft auf http://localhost:${PORT}`);
});
