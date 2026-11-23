import { detectBeats } from './beats.js'

/**
 * Lecteur audio : deux pistes par morceau (instrumental + voix) jouées en parfaite synchronisation.
 * Le mode choisit ce qu'on entend : le morceau complet, l'instrumental seul ou la voix seule.
 *
 * Graphe Web Audio :
 *   piste instru ──► gain instru ──┐
 *   piste voix   ──► gain voix   ──┼──► analyser ──► master (mute) ──► sortie
 *   scratch (AudioBuffer) ─────────┘
 *
 * Les deux pistes sont décodées en mémoire et démarrées au même instant (à l'échantillon près) :
 * changer de mode revient juste à monter / baisser leur volume, sans coupure.
 */

export const MODES = {
    original: { instru: 1, voix: 1 },
    instru: { instru: 1, voix: 0 },
    voix: { instru: 0, voix: 1 }
}

export default class Player extends EventTarget
{
    constructor(tracks)
    {
        super()
        this.tracks = tracks
        this.index = 0
        this.mode = 'original'
        this.muted = false
        this.switching = false // pendant le scratch entre deux morceaux
        this.loading = false   // pendant le téléchargement / décodage d'un morceau

        this._playing = false
        this.offset = 0        // position (s) quand on est en pause
        this.startedAt = 0     // instant (horloge audio) où la position 0 a été jouée
        this.sources = null
        this.current = null    // { instru, voix } : AudioBuffers du morceau en cours
        this.playToken = 0

        this.files = new Map()   // fichiers téléchargés (ArrayBuffers), par morceau
        this.buffers = new Map() // pistes décodées, par morceau
        this.beatGrids = new Map() // temps forts de chaque morceau (voir beats.js)
        this.beatJobs = new Map()

        this.decode(0) // on prépare le premier morceau tout de suite (pendant l'écran de chargement)
        setInterval(() => { if(this._playing) this.emit('update') }, 250)
    }

    emit(name) { this.dispatchEvent(new Event(name)) }

    get playing() { return this._playing }

    get duration() { return this.current?.instru.duration ?? NaN }

    get currentTime()
    {
        if(!this._playing || !this.ctx) return this.offset
        return Math.max(0, Math.min(this.ctx.currentTime - this.startedAt, this.duration || Infinity))
    }

    /** Le contexte audio ne peut démarrer qu'après un geste de l'utilisateur. */
    initAudio()
    {
        if(this.ctx) return this.ctx.resume()

        this.ctx = new AudioContext()
        this.master = this.ctx.createGain()
        this.master.gain.value = this.muted ? 0 : 1
        this.analyser = this.ctx.createAnalyser()
        this.analyser.fftSize = 1024
        this.analyser.smoothingTimeConstant = 0.6
        this.freqData = new Uint8Array(this.analyser.frequencyBinCount)

        this.gains = {}
        for(const stem of ['instru', 'voix'])
        {
            this.gains[stem] = this.ctx.createGain()
            this.gains[stem].gain.value = MODES[this.mode][stem]
            this.gains[stem].connect(this.analyser)
        }
        this.analyser.connect(this.master)
        this.master.connect(this.ctx.destination)
        return this.ctx.resume()
    }

    // ------------------------------------------------------------------ chargement

    /** Télécharge les deux pistes d'un morceau (sans les décoder), en suivant la progression */
    fetchFiles(index)
    {
        if(!this.files.has(index) && !this.buffers.has(index))
        {
            const { instru, voix } = this.tracks[index]
            const state = this.loadState(index)
            this.files.set(index, Promise.all([instru, voix].map((url, i) => fetchWithProgress(url, (loaded, total) =>
            {
                state.loaded[i] = loaded
                state.total[i] = total
            }))))
        }
        return this.files.get(index)
    }

    loadState(index)
    {
        this.loadStates ??= new Map()
        if(!this.loadStates.has(index)) this.loadStates.set(index, { loaded: [0, 0], total: [0, 0], decoded: false })
        return this.loadStates.get(index)
    }

    /** Progression du chargement d'un morceau (0 → 1) : téléchargement des deux pistes puis décodage */
    loadProgress(index)
    {
        const s = this.loadState(index)
        if(s.decoded) return 1
        const total = s.total[0] + s.total[1]
        const download = total ? (s.loaded[0] + s.loaded[1]) / total : 0
        return download * 0.85 // les 15 % restants = décodage
    }

    /**
     * Décode les deux pistes d'un morceau. On garde au plus 3 morceaux en mémoire.
     * Le décodage passe par un contexte "hors ligne" : il peut donc commencer avant le premier clic
     * (pendant l'écran de chargement), le son est prêt dès qu'on appuie sur "Écouter".
     */
    decode(index)
    {
        if(!this.buffers.has(index))
        {
            this.decoder ??= new OfflineAudioContext(2, 1, 44100)
            const job = this.fetchFiles(index)
                .then(([a, b]) => Promise.all([this.decoder.decodeAudioData(a), this.decoder.decodeAudioData(b)]))
                .then(([instru, voix]) =>
                {
                    this.loadState(index).decoded = true
                    return { instru, voix }
                })
                .catch((error) => { console.warn('[lecteur] morceau illisible', error); this.buffers.delete(index); return null })
                .finally(() => this.files.delete(index))
            this.buffers.set(index, job)

            for(const key of this.buffers.keys())
                if(this.buffers.size > 3 && key !== index && key !== this.index)
                {
                    this.buffers.delete(key)
                    this.loadStates?.delete(key)
                }
        }
        return this.buffers.get(index)
    }

    // ------------------------------------------------------------------ lecture

    startSources(offset)
    {
        this.stopNodes(this.sources)
        const when = this.ctx.currentTime + 0.03
        const s = {}
        for(const stem of ['instru', 'voix'])
        {
            s[stem] = this.ctx.createBufferSource()
            s[stem].buffer = this.current[stem]
            s[stem].connect(this.gains[stem])
            s[stem].start(when, offset)
        }
        // fin du morceau -> morceau suivant (onended se déclenche aussi sur stop() : on vérifie que c'est bien la fin)
        s.instru.onended = () =>
        {
            if(this.sources === s && this._playing)
                this.select((this.index + 1) % this.tracks.length, { scratch: false })
        }
        this.sources = s
        this.startedAt = when - offset
    }

    stopNodes(s)
    {
        if(!s) return
        if(this.sources === s) this.sources = null
        for(const node of [s.instru, s.voix])
            try { node.stop() } catch {}
    }

    async play()
    {
        await this.initAudio()
        const token = ++this.playToken
        const index = this.index
        this.loading = !(await Promise.race([this.buffers.get(index), Promise.resolve(false)]))
        this.emit('update')

        const buffers = await this.decode(index)
        if(token !== this.playToken) return // l'utilisateur a changé d'avis entre-temps
        this.loading = false
        if(!buffers) { this.emit('update'); return }

        this.current = buffers
        if(this.offset >= this.duration - 0.05) this.offset = 0
        this.startSources(this.offset)
        this._playing = true
        this.emit('update')

        this.analyseBeats(index)
        this.fetchFiles((index + 1) % this.tracks.length) // on prépare le morceau suivant
    }

    pause()
    {
        this.offset = this.currentTime
        this.playToken++
        this.stopNodes(this.sources)
        this._playing = false
        this.loading = false
        this.emit('update')
    }

    async toggle()
    {
        if(this._playing || this.loading) this.pause()
        else await this.play()
    }

    /** Change de morceau. Si un son est en cours, on le coupe avec un scratch. */
    async select(index, { scratch = true } = {})
    {
        if(this.switching) return
        if(index === this.index && this.current)
        {
            this.toggle()
            return
        }
        await this.initAudio()

        const wasPlaying = this._playing
        const from = this.index
        const at = this.currentTime
        this.index = index
        this.offset = 0
        this.emit('track')
        this.decode(index) // on prépare le nouveau morceau pendant le scratch

        if(wasPlaying && scratch)
        {
            this.switching = true
            this.brake()
            await this.scratch(from, at)
            this.switching = false
        }
        else
        {
            this.stopNodes(this.sources)
            this._playing = false
        }
        await this.play()
    }

    seek(ratio)
    {
        if(!this.current) return
        this.offset = ratio * this.duration
        if(this._playing) this.startSources(this.offset)
        this.emit('update')
    }

    /** 'original' | 'instru' | 'voix' : fondu très court entre les pistes, la lecture continue */
    setMode(mode)
    {
        if(!MODES[mode]) return
        this.mode = mode
        if(this.gains)
            for(const stem of ['instru', 'voix'])
                this.gains[stem].gain.setTargetAtTime(MODES[mode][stem], this.ctx.currentTime, 0.04)
        this.emit('mode')
    }

    toggleMute()
    {
        this.muted = !this.muted
        if(this.master)
            this.master.gain.setTargetAtTime(this.muted ? 0 : 1, this.ctx.currentTime, 0.03)
        this.emit('update')
    }

    // ------------------------------------------------------------------ analyse

    /**
     * Analyse du son, à appeler une fois par image.
     * - bass     : volume des basses (0 → 1)
     * - beat     : true à l'image où un temps fort est atteint
     * - strength : force du temps fort (0 → 1)
     * - spectrum : volume de chaque bande de fréquence (Uint8Array, 0 → 255), des graves aux aigus
     *
     * Les temps forts viennent d'une analyse faite à l'avance sur tout le morceau (voir beats.js).
     */
    analyse()
    {
        const result = this.analysis ??= { bass: 0, beat: false, strength: 0, spectrum: null }
        result.beat = false
        result.strength = 0
        if(!this.analyser || !this._playing)
        {
            result.bass = 0
            result.spectrum = this.freqData?.fill(0) ?? null
            return result
        }

        const f = this.freqData
        this.analyser.getByteFrequencyData(f)
        result.spectrum = f

        let bass = 0
        for(let i = 1; i <= 5; i++) bass += f[i]
        result.bass = bass / (5 * 255)

        // temps forts : instant entendu = position de lecture - latence de la sortie audio
        const grid = this.beatGrids.get(this.index)
        const t = this.currentTime - (this.ctx.outputLatency || 0) - (this.ctx.baseLatency || 0)
        if(grid)
        {
            const times = grid.times
            if(this.gridTrack !== this.index || t < this.lastT - 0.05 || t - this.lastT > 0.5)
            {
                let lo = 0, hi = times.length
                while(lo < hi) { const mid = (lo + hi) >> 1; if(times[mid] < t) lo = mid + 1; else hi = mid }
                this.gridIndex = lo
                this.gridTrack = this.index
            }
            while(this.gridIndex < times.length && times[this.gridIndex] <= t)
            {
                if(t - times[this.gridIndex] < 0.1)
                {
                    result.beat = true
                    result.strength = Math.max(result.strength, grid.strengths[this.gridIndex])
                }
                this.gridIndex++
            }
        }
        this.lastT = t
        return result
    }

    /** Analyse les temps forts d'un morceau (une seule fois, en arrière-plan, sur l'instrumental) */
    analyseBeats(index)
    {
        if(!this.beatsEnabled) return
        if(this.beatGrids.has(index) || this.beatJobs.has(index)) return
        const job = this.decode(index)
            .then(buffers => buffers && detectBeats(buffers.instru))
            .then(grid =>
            {
                if(grid)
                {
                    this.beatGrids.set(index, grid)
                    console.info(`[temps forts] ${this.tracks[index].title} : ${grid.bpm.toFixed(1)} BPM, ${grid.times.length} temps`)
                }
            })
            .catch((error) => console.warn('[temps forts] analyse impossible', error))
        this.beatJobs.set(index, job)
    }

    // ------------------------------------------------------------------ scratch

    /** Position du disque pendant le scratch (en secondes d'audio), ou null hors scratch. Sert à animer le vinyle. */
    getScratchOffset()
    {
        const c = this.scratchCurve
        if(!c) return null
        const t = (performance.now() - c.start) / 1000
        if(t >= c.duration) { this.scratchCurve = null; return null }
        return c.pos[Math.min(Math.floor(t * c.sr), c.pos.length - 1)]
    }

    /** Ralentit le disque comme si on posait la main dessus, puis l'arrête. */
    brake()
    {
        const s = this.sources
        if(!s) return
        const now = this.ctx.currentTime
        for(const node of [s.instru, s.voix])
        {
            node.playbackRate.setValueAtTime(1, now)
            node.playbackRate.linearRampToValueAtTime(0.05, now + 0.18)
        }
        this._playing = false
        setTimeout(() => this.stopNodes(s), 190)
    }

    /**
     * Scratch "va-et-vient" joué à partir du vrai son du morceau (dans le mode en cours), autour de la position courante.
     * On recalcule l'échantillon lu selon une courbe de position du disque (avant / arrière).
     */
    async scratch(index, at)
    {
        const ctx = this.ctx
        const buffers = await Promise.race([this.buffers.get(index), new Promise(r => setTimeout(() => r(null), 150))])
        const sr = ctx.sampleRate
        const duration = 0.62
        const length = Math.floor(duration * sr)
        const out = ctx.createBuffer(2, length, sr)

        // position du disque (en secondes, relative à "at") : 3 allers-retours de plus en plus courts
        const strokes = [[0, -0.16, 0.13], [-0.16, 0.02, 0.1], [0.02, -0.12, 0.11], [-0.12, 0.0, 0.08], [0, -0.07, 0.09], [-0.07, -0.02, 0.11]]
        const pos = new Float32Array(length)
        let i = 0
        for(const [a, b, d] of strokes)
        {
            const n = Math.floor(d * sr)
            for(let k = 0; k < n && i < length; k++, i++)
            {
                const t = k / n
                const e = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2 // ease in-out
                pos[i] = a + (b - a) * e
            }
        }
        for(; i < length; i++) pos[i] = pos[i - 1]

        const mix = MODES[this.mode]
        for(let c = 0; c < 2; c++)
        {
            const dst = out.getChannelData(c)
            if(buffers)
            {
                const ch = (b) => b.getChannelData(Math.min(c, b.numberOfChannels - 1))
                const srcI = ch(buffers.instru), srcV = ch(buffers.voix)
                const r = buffers.instru.sampleRate
                const base = at * r
                for(let j = 0; j < length; j++)
                {
                    const p = base + pos[j] * r
                    const k = Math.floor(p)
                    const f = p - k
                    const s0 = (srcI[k] || 0) * mix.instru + (srcV[k] || 0) * mix.voix
                    const s1 = (srcI[k + 1] || 0) * mix.instru + (srcV[k + 1] || 0) * mix.voix
                    // le son disparaît quand le disque est immobile (vitesse nulle)
                    const v = j > 0 ? Math.min(Math.abs(pos[j] - pos[j - 1]) * sr * 1.5, 1) : 0
                    dst[j] = (s0 + (s1 - s0) * f) * v
                }
            }
            else
            {
                // morceau pas encore décodé : scratch synthétique (bruit modulé par la vitesse)
                for(let j = 1; j < length; j++)
                {
                    const v = Math.min(Math.abs(pos[j] - pos[j - 1]) * sr * 1.5, 1)
                    dst[j] = (Math.random() * 2 - 1) * 0.35 * v
                }
            }
        }

        const node = ctx.createBufferSource()
        node.buffer = out
        const filter = ctx.createBiquadFilter() // léger côté "vinyle"
        filter.type = 'lowpass'
        filter.frequency.value = 5500
        const gain = ctx.createGain()
        gain.gain.setValueAtTime(1, ctx.currentTime)
        gain.gain.setTargetAtTime(0, ctx.currentTime + duration - 0.08, 0.02)
        node.connect(filter).connect(gain).connect(this.analyser)
        node.start()
        this.scratchCurve = { start: performance.now(), pos, sr, duration }
        await new Promise(r => setTimeout(r, duration * 1000 - 40))
    }
}

/** Télécharge un fichier en signalant la progression (octets reçus / total) */
async function fetchWithProgress(url, onProgress)
{
    const response = await fetch(url)
    if(!response.ok) throw new Error(`${url} : ${response.status}`)
    const total = Number(response.headers.get('content-length')) || 0
    if(!response.body || !total)
    {
        const data = await response.arrayBuffer()
        onProgress(data.byteLength, data.byteLength)
        return data
    }
    const reader = response.body.getReader()
    const bytes = new Uint8Array(total)
    let loaded = 0
    for(;;)
    {
        const { done, value } = await reader.read()
        if(done) break
        bytes.set(value, loaded)
        loaded += value.length
        onProgress(loaded, total)
    }
    return bytes.buffer
}

/** Formate des secondes en m:ss */
export const formatTime = (s) =>
{
    if(!isFinite(s)) return '0:00'
    const m = Math.floor(s / 60)
    return `${m}:${String(Math.floor(s % 60)).padStart(2, '0')}`
}
