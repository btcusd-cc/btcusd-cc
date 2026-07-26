// evaluate.js
const crypto = require('crypto');

// Konfigurace Supabase (Nahraď nebo načti z process.env)
const SUPABASE_URL = process.env.SUPABASE_URL || "https://euizdmlikpncmqwkfmhn.supabase.co";
const SUPABASE_KEY = process.env.SUPABASE_KEY || "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImV1aXpkbWxpa3BuY21xd2tmbWhuIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc4NDA0OTMzOSwiZXhwIjoyMDk5NjI1MzM5fQ.LcConn3D37unzte6j6MrBhIKPeh5XQFT87n2UohNE8k";

// Pomocná funkce pro Supabase REST API
async function supabaseFetch(endpoint, options = {}) {
    const url = `${SUPABASE_URL}/rest/v1/${endpoint}`;
    const headers = {
        'apikey': SUPABASE_KEY,
        'Authorization': `Bearer ${SUPABASE_KEY}`,
        'Content-Type': 'application/json',
        ...options.headers
    };
    const response = await fetch(url, { ...options, headers });
    if (!response.ok) {
        const text = await response.text();
        throw new Error(`Supabase API Error (${response.status}): ${text}`);
    }
    return response.status !== 204 ? await response.json() : null;
}

// Pomocná funkce pro aktuální Week ID (např. "2026-W30")
function getWeekIdentifier(date = new Date()) {
    const oneJan = new Date(date.getFullYear(), 0, 1);
    const numberOfDays = Math.floor((date - oneJan) / (24 * 60 * 60 * 1000));
    const weekNumber = Math.ceil((date.getDay() + 1 + numberOfDays) / 7);
    return `${date.getFullYear()}-W${weekNumber}`;
}

// 1. FÁZE: Zamknutí a generování SHA-256 Hashe (Pátek 23:00 UTC)
async function lockWeek(weekId) {
    console.log(`🔒 Spouštím uzamčení a generování SHA-256 pro týden: ${weekId}`);

    // Stáhneme všechny tipy seřazené podle ID pro konzistentní hash
    const predictions = await supabaseFetch(`predictions?week_id=eq.${weekId}&select=id,username,price_prediction,btc_address,created_at&order=id.asc`);

    if (!predictions || predictions.length === 0) {
        console.log("⚠️ Žádné tipy pro tento týden nebyly nalezeny.");
        return;
    }

    // Vytvoříme deterministický řetězec z dat tipů
    const rawDataString = JSON.stringify(predictions);
    const hash = crypto.createHash('sha256').update(rawDataString).digest('hex');

    console.log(`✅ SHA-256 Hash vygenerován: ${hash}`);
    console.log(`📊 Celkem zamknuto tipů: ${predictions.length}`);

    // Spočítáme aktuální bank
    const fullPredictions = await supabaseFetch(`predictions?week_id=eq.${weekId}&select=entry_fee`);
    const totalPool = fullPredictions.reduce((sum, p) => sum + (p.entry_fee || 1000), 0);

    // Uložíme do tabulky weeks
    await supabaseFetch(`weeks`, {
        method: 'POST',
        headers: { 'Prefer': 'resolution=merge-duplicates' },
        body: JSON.stringify({
            week_id: weekId,
            sha256_hash: hash,
            total_pool_sats: totalPool,
            status: 'LOCKED'
        })
    });

    console.log("💾 Hash a stav LOCKED úspěšně uloženy do databáze.");
}

// 2. FÁZE: Vyhodnocení vítězů a ceny BTC (Neděle 23:59 UTC)
async function evaluateWeek(weekId) {
    console.log(`🏆 Spouštím vyhodnocení pro týden: ${weekId}`);

    // 1. Získání finální zavírací ceny BTC z Binance API
    const btcRes = await fetch('https://api.binance.com/api/v3/ticker/price?symbol=BTCUSDT');
    const btcData = await btcRes.json();
    const finalBtcPrice = parseFloat(btcData.price);

    console.log(`📌 Finální cena BTC: $${finalBtcPrice.toLocaleString('en-US', {minimumFractionDigits: 2})}`);

    // 2. Načtení všech tipů pro daný týden
    const predictions = await supabaseFetch(`predictions?week_id=eq.${weekId}&select=*`);

    if (!predictions || predictions.length === 0) {
        console.log("⚠️ Žádné tipy k vyhodnocení.");
        return;
    }

    // 3. Výpočet odchylky pro každý tip
    let minDiff = Infinity;
    const scoredPredictions = predictions.map(p => {
        const diff = Math.abs(parseFloat(p.price_prediction) - finalBtcPrice);
        if (diff < minDiff) minDiff = diff;
        return { ...p, diff };
    });

    // 4. Najdeme všechny tipy s nejnižší odchylkou (vítěze)
    const winners = scoredPredictions.filter(p => p.diff === minDiff);
    
    // Spočítáme celkový bank a podíl pro každého vítěze
    const totalPool = predictions.reduce((sum, p) => sum + (p.entry_fee || 1000), 0);
    const payoutPerWinner = Math.floor(totalPool / winners.length);

    console.log(`🎉 Nalezeno vítězů: ${winners.length} (Nejmenší odchylka: $${minDiff.toFixed(2)})`);
    console.log(`💰 Celkový bank: ${totalPool} Sats | Výhra na jednoho: ${payoutPerWinner} Sats`);

    // 5. Uložení vítězů do tabulky winners
    for (const winner of winners) {
        await supabaseFetch(`winners`, {
            method: 'POST',
            body: JSON.stringify({
                week_id: weekId,
                prediction_id: winner.id,
                username: winner.username,
                btc_address: winner.btc_address,
                payout_sats: payoutPerWinner
            })
        });
        console.log(`🥇 Vítěz zapísán: ${winner.username} ($${winner.price_prediction}) -> ${winner.btc_address}`);
    }

    // 6. Aktualizace stavu v tabulce weeks
    await supabaseFetch(`weeks?week_id=eq.${weekId}`, {
        method: 'PATCH',
        body: JSON.stringify({
            final_btc_price: finalBtcPrice,
            total_pool_sats: totalPool,
            status: 'EVALUATED'
        })
    });

    console.log("✅ Vyhodnocení týdne je kompletní!");
}

// Spuštění podle CLI argumentů
const args = process.argv.slice(2);
const actionArg = args.find(a => a.startsWith('--action='));
const action = actionArg ? actionArg.split('=')[1] : null;

const currentWeek = getWeekIdentifier();

if (action === 'lock') {
    lockWeek(currentWeek).catch(console.error);
} else if (action === 'evaluate') {
    evaluateWeek(currentWeek).catch(console.error);
} else {
    console.log("Použití:");
    console.log("  node evaluate.js --action=lock      (Spustit v pátek ve 23:00 UTC)");
    console.log("  node evaluate.js --action=evaluate  (Spustit v neděli ve 23:59 UTC)");
}