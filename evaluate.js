// evaluate.js
const crypto = require('crypto');

// Ošetření načtení Supabase URL a KEY
const DEFAULT_URL = "https://euizdmlikpncmqwkfmhn.supabase.co";
let rawUrl = process.env.SUPABASE_URL || DEFAULT_URL;

if (!rawUrl.startsWith('http')) {
    rawUrl = DEFAULT_URL;
}
const SUPABASE_URL = rawUrl.replace(/\/$/, ""); 
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
    
    const text = await response.text();
    return text ? JSON.parse(text) : null;
}

// ISO-8601 výpočet týdne (Pondělí = začátek týdne, 2-místný kód týdne)
function getWeekIdentifier(d = new Date()) {
    const date = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
    const dayNum = date.getUTCDay() || 7;
    date.setUTCDate(date.getUTCDate() + 4 - dayNum);
    const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
    const weekNo = Math.ceil((((date - yearStart) / 86400000) + 1) / 7);
    const formattedWeek = weekNo < 10 ? `0${weekNo}` : weekNo;
    return `${date.getUTCFullYear()}-W${formattedWeek}`;
}

// Pomocná funkce pro získání historické zavírací ceny z Binance k nedělní půlnoci (23:59:59 UTC)
async function getSundayClosePrice() {
    console.log("📡 Načítám historickou nedělní zavírací cenu BTC z Binance (K-Lines API)...");
    
    // Zjistíme UTC timestamp pro nedělní 23:59:59 (konec aktuálního/proběhlého ISO týdne)
    const now = new Date();
    const currentDay = now.getUTCDay(); // 0 = Neděle, 1 = Pondělí...
    const daysSinceSunday = currentDay === 0 ? 0 : currentDay;
    
    const targetSunday = new Date(Date.UTC(
        now.getUTCFullYear(),
        now.getUTCMonth(),
        now.getUTCDate() - daysSinceSunday,
        23, 59, 59, 999
    ));

    const endTime = targetSunday.getTime();
    
    // Dotaz na 1m svíčku končící v neděli ve 23:59:59 UTC
    const endpoint = `api/v3/klines?symbol=BTCUSDT&interval=1m&endTime=${endTime}&limit=1`;
    
    let res = await fetch(`https://api.binance.com/${endpoint}`);
    if (res.status === 451 || res.status === 403) {
        console.log("⚠️ Globální Binance endpoint vrátil geoblock. Přepínám na Binance US...");
        res = await fetch(`https://api.binance.us/${endpoint}`);
    }

    if (!res.ok) {
        throw new Error(`❌ Chyba Binance API: Odpověď serveru ${res.status} ${res.statusText}`);
    }

    const data = await res.json();
    if (!data || data.length === 0) {
        throw new Error("❌ Z Binance se nepodařilo načíst historickou svíčku pro nedělní půlnoc.");
    }

    // Index 4 v Binance Klines poli reprezentuje 'Close price' (zavírací cenu) svíčky
    const closePrice = parseFloat(data[0][4]);
    return closePrice;
}

// 1. FÁZE: Zamknutí a generování SHA-256 Hashe (Pátek 23:00 UTC)
async function lockWeek(weekId) {
    console.log(`🔍 Hledám tipy v Supabase pro týden: "${weekId}"...`);

    const predictions = await supabaseFetch(`predictions?week_id=eq.${weekId}&select=id,username,price_prediction,btc_address,created_at&order=id.asc`);

    console.log(`📦 Nalezeno záznamů v predictions: ${predictions ? predictions.length : 0}`);

    if (!predictions || predictions.length === 0) {
        console.log(`⚠️ Žádné tipy pro týden ${weekId} nebyly v databázi nalezeny.`);
        return;
    }

    const rawDataString = JSON.stringify(predictions);
    const hash = crypto.createHash('sha256').update(rawDataString).digest('hex');

    console.log(`✅ SHA-256 Hash vygenerován: ${hash}`);

    const fullPredictions = await supabaseFetch(`predictions?week_id=eq.${weekId}&select=entry_fee`);
    const totalPool = fullPredictions.reduce((sum, p) => sum + (p.entry_fee || 1000), 0);

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

    // --- POJISTKA PROTI DUPLICITNÍMU VYHODNOCENÍ ---
    const existingWinners = await supabaseFetch(`winners?week_id=eq.${weekId}&select=id`);
    if (existingWinners && existingWinners.length > 0) {
        console.log(`🛑 POJISTKA: Týden ${weekId} už byl v databázi vyhodnocen. Přeskakuji opakováné vyhodnocení.`);
        return;
    }

    // 1. Získání přesné nedělní zavírací ceny z Binance
    const finalBtcPrice = await getSundayClosePrice();
    console.log(`📌 Oficiální nedělní zavírací cena BTC (23:59 UTC): $${finalBtcPrice.toLocaleString('en-US', {minimumFractionDigits: 2, maximumFractionDigits: 2})}`);

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
        console.log(`🥇 Vítěz zapsán: ${winner.username} (Tip: $${winner.price_prediction}) -> Payout adresa: ${winner.btc_address}`);
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