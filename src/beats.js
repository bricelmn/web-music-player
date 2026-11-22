/**
 * Détection des temps forts d'un morceau, calculée une fois à l'avance sur le son décodé.
 *
 * 1. on ne garde que les basses (filtre passe-bas ~150 Hz) : c'est là que vit la grosse caisse
 * 2. on mesure l'énergie toutes les ~12 ms et on repère les "attaques" (montées brusques)
 * 3. on cherche la période qui revient le plus régulièrement -> le tempo (BPM)
 * 4. on cale une grille de temps sur ces attaques, puis on aligne chaque temps sur l'attaque la plus proche
 *
 * Résultat : { bpm, times, strengths } — les instants (en secondes) de chaque temps fort et leur force (0 → 1).
 */

const HOP = 512

export async function detectBeats(buffer)
{
    const sr = buffer.sampleRate

    // 1. basses seulement (deux filtres en série pour une coupure nette)
    const offline = new OfflineAudioContext(1, buffer.length, sr)
    const source = offline.createBufferSource()
    source.buffer = buffer
    const lp1 = offline.createBiquadFilter()
    const lp2 = offline.createBiquadFilter()
    lp1.type = lp2.type = 'lowpass'
    lp1.frequency.value = lp2.frequency.value = 150
    source.connect(lp1).connect(lp2).connect(offline.destination)
    source.start()
    const low = (await offline.startRendering()).getChannelData(0)

    // 2. énergie par tranche, puis attaques (montée d'énergie au-dessus de la moyenne locale)
    const n = Math.floor(low.length / HOP)
    const fps = sr / HOP
    const energy = new Float32Array(n)
    for(let i = 0; i < n; i++)
    {
        let sum = 0
        for(let j = i * HOP, end = j + HOP; j < end; j++) sum += low[j] * low[j]
        energy[i] = Math.sqrt(sum / HOP)
    }
    const rise = new Float32Array(n)
    for(let i = 1; i < n; i++) rise[i] = Math.max(0, energy[i] - energy[i - 1])
    const onset = new Float32Array(n)
    const win = Math.round(fps * 0.25)
    let acc = 0
    for(let i = 0; i < n; i++)
    {
        acc += rise[i]
        if(i - 2 * win >= 0) acc -= rise[i - 2 * win]
        const center = i - win
        if(center >= 0) onset[center] = Math.max(0, rise[center] - acc / (2 * win))
    }

    // 3. tempo : autocorrélation des attaques entre 70 et 180 BPM (légère préférence autour de 120)
    const minLag = Math.floor(fps * 60 / 180)
    const maxLag = Math.ceil(fps * 60 / 70)
    let bestLag = minLag, bestScore = -1
    for(let lag = minLag; lag <= maxLag; lag++)
    {
        let s = 0
        for(let i = 0; i + lag < n; i++) s += onset[i] * onset[i + lag]
        const bpm = 60 * fps / lag
        s *= Math.exp(-0.5 * Math.pow(Math.log2(bpm / 120) / 0.8, 2))
        if(s > bestScore) { bestScore = s; bestLag = lag }
    }

    // 4. période précise (au centième de tranche) et décalage de la grille
    const peak = (i) => Math.max(onset[i - 1] ?? 0, onset[i] ?? 0, onset[i + 1] ?? 0)
    let best = { period: bestLag, phase: 0, score: -1 }
    for(let period = bestLag - 1; period <= bestLag + 1; period += 0.02)
    {
        for(let phase = 0; phase < period; phase += 0.5)
        {
            let s = 0
            for(let t = phase; t < n; t += period) s += peak(Math.round(t))
            if(s > best.score) best = { period, phase, score: s }
        }
    }

    // grille alignée sur l'attaque la plus proche (±35 ms), force relative de chaque temps
    const snap = Math.round(fps * 0.035)
    const frames = []
    for(let t = best.phase; t < n; t += best.period)
    {
        const c = Math.round(t)
        let at = c, v = onset[c] ?? 0
        for(let k = c - snap; k <= c + snap; k++)
            if((onset[k] ?? 0) > v) { v = onset[k]; at = k }
        frames.push([at, v])
    }
    const sorted = frames.map(f => f[1]).sort((a, b) => a - b)
    const ref = sorted[Math.floor(sorted.length * 0.9)] || 1

    const times = [], strengths = []
    for(const [at, v] of frames)
    {
        const strength = Math.min(1, v / ref)
        if(strength < 0.2) continue // passages calmes : pas de temps fort
        times.push(at / fps)
        strengths.push(strength)
    }
    return { bpm: 60 * fps / best.period, times: Float32Array.from(times), strengths: Float32Array.from(strengths) }
}
