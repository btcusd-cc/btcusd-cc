// evaluate.js
const crypto = require('crypto');

// Ošetření načtení Supabase URL a KEY
const DEFAULT_URL = "https://euizdmlikpncmqwkfmhn.supabase.co";
let rawUrl = process.env.SUPABASE_URL || DEFAULT_URL;

// Odstranění případných uvozovek nebo bílých znaků z ENV proměnné
if (!rawUrl.startsWith('http')) {
    rawUrl = DEFAULT_URL;
}
const SUPABASE_URL = rawUrl.replace(/\/$/, ""); // Odstraní případné lomítko na konci
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY;

if (!SUPABASE_KEY) {
    throw new Error("❌ Chybí SUPABASE_SERVICE_ROLE_KEY v proměnných prostředí (Secrets)!");
}

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
    
    // Bezpečné načtení textu z odpovědi
    const text = await response.text();
    // Pokud je odpověď prázdná (např. při uložení do databáze), vrátíme null místo chyby
    return text ? JSON.parse(text) : null;
}

// Pomocná funkce pro identickou kalkulaci week_id jako v index.html
function getWeekIdentifier(date = new Date()) {
    const oneJan = new Date(date.getFullYear(), 0, 1);
    const numberOfDays = Math.floor((date - oneJan) / (24 * 60 * 60 * 1000));
    const weekNumber = Math.ceil((date.getDay() + 1 + numberOfDays) / 7);
    return `${date.getFullYear()}-W${weekNumber}`;
}

// 1. FÁZE: Zamknutí a generování SHA-256 Hashe (Pátek 23:00 UTC)
async function lockWeek(weekId) {
    console.log(`🔍 Hledám tipy v Supabase pro týden: "${weekId}"...`);

    // Stáhneme všechny tipy pro daný týden
    const predictions = await supabaseFetch(`predictions?week_id=eq.${weekId}&select=id,username,price_prediction,btc_address,created_at&order=id.asc`);

    console.log(`📦 Nalezeno záznamů v predictions: ${predictions ? predictions.length : 0}`);

    if (!predictions || predictions.length === 0) {
        console.log(`⚠️ Žádné tipy pro týden ${weekId} nebyly v databázi nalezeny.`);
        return;
    }

    // Vytvoříme deterministický řetězec z dat tipů
    const rawDataString = JSON.stringify(predictions);
    const hash = crypto.createHash('sha256').update(rawDataString).digest('hex');

    console.log(`✅ SHA-256 Hash vygenerován: ${hash}`);

    // Spočítáme celkový bank
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

    console.log(`💾 Týden ${weekId} se úspěšně zamknul do tabulky weeks se stavem LOCKED!`);
}

// 2. FÁZE: Vyhodnocení vítězů a ceny BTC (Neděle 23:59 UTC)
async function evaluateWeek(weekId) {
    console.log(`🏆 Spouštím vyhodnocení pro týden: "${weekId}"...`);

    // 1. Získání finální zavírací ceny BTC výhradně z Binance API
    console.log("📡 Načítám oficiální cenu BTCUSDT z Binance...");
    
    let btcRes = await fetch('https://api.binance.com/api/v3/ticker/price?symbol=BTCUSDT');
    
    // Pokud GitHub runner dostane geoblock (HTTP 451/403), použijeme Binance US endpoint
    if (btcRes.status === 451 || btcRes.status === 403) {
        console.log("⚠️ Globální Binance endpoint vrátil geoblock. Načítám z Binance US...");
        btcRes = await fetch('https://api.binance.us/api/v3/ticker/price?symbol=BTCUSDT');
    }

    if (!btcRes.ok) {
        throw new Error(`❌ Chyba Binance API: Odpověď serveru ${btcRes.status} ${btcRes.statusText}`);
    }

    const btcData = await btcRes.json();
    const rawPrice = btcData && btcData.price;
    const finalBtcPrice = Number(rawPrice);

    if (!rawPrice || isNaN(finalBtcPrice)) {
        throw new Error(`❌ Binance API vrátilo neplatný formát ceny: "${rawPrice}"`);
    }

    console.log(`📌 Oficiální cena BTC (Binance BTCUSDT): $${finalBtcPrice.toLocaleString('en-US', {minimumFractionDigits: 2, maximumFractionDigits: 2})}`);

    // 2. Načtení všech tipů pro daný týden
    const predictions = await supabaseFetch(`predictions?week_id=eq.${weekId}&select=*`);

    console.log(`📦 Nalezeno tipů k vyhodnocení: ${predictions ? predictions.length : 0}`);

    if (!predictions || predictions.length === 0) {
        console.log(`⚠️ Žádné tipy pro týden ${weekId} nebyly nalezeny.`);
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

    console.log(`🎉 Počet vítězů: ${winners.length} (Nejmenší odchylka od ceny: $${minDiff.toFixed(2)})`);
    console.log(`💰 Celkový bank: ${totalPool} Sats | Výhra na osobu: ${payoutPerWinner} Sats`);

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
        console.log(`🥇 Vítěz zapísán: ${winner.username} (Tip: $${winner.price_prediction}) -> Payout adresa: ${winner.btc_address}`);
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

    console.log(`✅ Vyhodnocení týdne ${weekId} je kompletní!`);
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