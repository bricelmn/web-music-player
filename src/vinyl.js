import * as THREE from 'three'

/**
 * Pochette vinyle + disque.
 *
 * - la pochette est composée à la volée dans un <canvas> (fond clair moucheté + poupée HD + titre)
 * - le disque sort de la pochette quand la musique joue, et tourne à 33 tours
 * - pendant le scratch, le disque fait les mêmes allers-retours que le son
 */

const SIZE = 2            // côté de la pochette (unités Three.js)
const DISC_RADIUS = 0.96
const OFFSET = -0.45
const BAR_COUNT = 96
const RPM_SPEED = (33.3 / 60) * Math.PI * 2 // rad/s à 33 tours

const loadImage = (src) => new Promise((resolve, reject) =>
{
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = reject
    img.src = src
})

const makeCanvas = (s) =>
{
    const canvas = document.createElement('canvas')
    canvas.width = canvas.height = s
    return [canvas, canvas.getContext('2d', { willReadFrequently: true })]
}

/** Position de la poupée sur la pochette (la même pour toutes les textures) */
const dollRect = (doll, s) =>
{
    const h = s * 0.78
    const w = h * (doll.width / doll.height)
    return [(s - w) / 2, s * 0.08, w, h]
}

/** Usure en anneau laissée par le disque rangé dans la pochette ("ring wear") */
const RING = { r: 0.43, width: 0.035 }
const ringWear = (ctx, s, color, strength) =>
{
    ctx.save()
    ctx.lineCap = 'round'
    for(let i = 0; i < 900; i++)
    {
        const a = Math.random() * Math.PI * 2
        const len = Math.random() * 0.08
        const r = s * (RING.r + (Math.random() - 0.5) * RING.width)
        // l'usure est plus marquée en haut à droite, là où le disque frotte le plus
        const bias = 0.35 + 0.65 * Math.max(0, Math.cos(a + Math.PI / 4))
        ctx.strokeStyle = color(Math.random() * strength * bias)
        ctx.lineWidth = Math.random() * s * 0.004 + 1
        ctx.beginPath()
        ctx.arc(s / 2, s / 2, r, a, a + len)
        ctx.stroke()
    }
    ctx.restore()
}

/** Bords et coins usés : petites éraflures claires le long des bords */
const edgeWear = (ctx, s) =>
{
    for(let i = 0; i < 1400; i++)
    {
        const side = Math.floor(Math.random() * 4)
        const t = Math.random() * s
        const d = Math.pow(Math.random(), 3) * s * 0.018
        const [x, y] = [[t, d], [s - d, t], [t, s - d], [d, t]][side]
        ctx.fillStyle = `rgba(255, 255, 255, ${Math.random() * 0.5})`
        ctx.fillRect(x, y, Math.random() * 6 + 1, Math.random() * 6 + 1)
    }
    // coins un peu plus abîmés
    for(const [cx, cy] of [[0, 0], [s, 0], [0, s], [s, s]])
    {
        const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, s * 0.05)
        g.addColorStop(0, 'rgba(255, 255, 255, 0.45)')
        g.addColorStop(1, 'rgba(255, 255, 255, 0)')
        ctx.fillStyle = g
        ctx.fillRect(cx - s * 0.05, cy - s * 0.05, s * 0.1, s * 0.1)
    }
}

/**
 * Textures de surface (1024 px) : relief, brillance, vernis.
 * - relief : grain du carton + poupée bombée (gaufrage) + léger creux de l'anneau d'usure
 * - brillance : carton mat, encre de la poupée satinée, anneau d'usure un peu lustré
 * - vernis : uniquement sur la poupée (vernis sélectif)
 */
const drawSurface = (doll) =>
{
    const s = 1024
    const [, ctx] = makeCanvas(s)
    const [x, y, w, h] = dollRect(doll, s)

    // silhouette de la poupée floutée à deux niveaux -> profil arrondi
    const silhouette = (blur) =>
    {
        ctx.clearRect(0, 0, s, s)
        ctx.filter = `blur(${blur}px)`
        ctx.drawImage(doll, x, y, w, h)
        ctx.filter = 'none'
        const data = ctx.getImageData(0, 0, s, s).data
        const a = new Float32Array(s * s)
        for(let i = 0; i < a.length; i++) a[i] = data[i * 4 + 3] / 255
        return a
    }
    const sharp = silhouette(1.5)
    const soft = silhouette(5)

    // anneau d'usure, dessiné dans une couche à part
    ctx.clearRect(0, 0, s, s)
    ringWear(ctx, s, (v) => `rgba(255, 255, 255, ${v})`, 0.9)
    const ringData = ctx.getImageData(0, 0, s, s).data

    const height = new Float32Array(s * s)
    const [rough, coat] = [makeCanvas(s), makeCanvas(s)]
    const roughImg = rough[1].createImageData(s, s)
    const coatImg = coat[1].createImageData(s, s)
    for(let i = 0; i < s * s; i++)
    {
        const ring = ringData[i * 4 + 3] / 255
        const ink = sharp[i]
        height[i] = sharp[i] * 0.55 + soft[i] * 0.45 + (Math.random() - 0.5) * 0.035 - ring * 0.04
        const r = 205 * (1 - ink) + 95 * ink - ring * 45 + (Math.random() - 0.5) * 12
        const c = ink > 0.5 ? 255 : ink * 510
        roughImg.data.set([r, r, r, 255], i * 4)
        coatImg.data.set([c, c, c, 255], i * 4)
    }
    rough[1].putImageData(roughImg, 0, 0)
    coat[1].putImageData(coatImg, 0, 0)

    // carte de normales calculée à partir du relief
    const normal = makeCanvas(s)
    const normalImg = normal[1].createImageData(s, s)
    const k = 6 // intensité du relief
    const at = (px, py) => height[Math.min(s - 1, Math.max(0, py)) * s + Math.min(s - 1, Math.max(0, px))]
    for(let py = 0; py < s; py++)
    {
        for(let px = 0; px < s; px++)
        {
            const nx = (at(px - 1, py) - at(px + 1, py)) * k
            const ny = (at(px, py + 1) - at(px, py - 1)) * k
            const len = Math.hypot(nx, ny, 1)
            normalImg.data.set([(nx / len * 0.5 + 0.5) * 255, (ny / len * 0.5 + 0.5) * 255, (1 / len * 0.5 + 0.5) * 255, 255], (py * s + px) * 4)
        }
    }
    normal[1].putImageData(normalImg, 0, 0)

    return { normal: normal[0], roughness: rough[0], clearcoat: coat[0] }
}

/** Pochette : fond gris clair avec poussières, poupée au centre, titre en bas à droite */
const drawCover = (doll, title) =>
{
    const s = 2048
    const [canvas, ctx] = makeCanvas(s)

    const bg = ctx.createRadialGradient(s * 0.45, s * 0.35, s * 0.1, s * 0.5, s * 0.5, s * 0.8)
    bg.addColorStop(0, '#f7f7f9')
    bg.addColorStop(1, '#d6d6dc')
    ctx.fillStyle = bg
    ctx.fillRect(0, 0, s, s)

    // poussières et grain
    for(let i = 0; i < 2500; i++)
    {
        ctx.fillStyle = `rgba(60, 60, 70, ${Math.random() * 0.18})`
        const r = Math.random() < 0.95 ? Math.random() * 1.6 : Math.random() * 4
        ctx.beginPath()
        ctx.arc(Math.random() * s, Math.random() * s, r, 0, Math.PI * 2)
        ctx.fill()
    }

    // usure : anneau du disque (légèrement plus clair, carton frotté) et bords
    ringWear(ctx, s, (v) => `rgba(120, 110, 125, ${v * 0.35})`, 1)
    edgeWear(ctx, s)

    // poupée avec une ombre douce, comme sur la pochette d'origine
    ctx.save()
    ctx.shadowColor = 'rgba(80, 0, 40, 0.35)'
    ctx.shadowBlur = 40
    ctx.shadowOffsetX = 18
    ctx.shadowOffsetY = 24
    ctx.drawImage(doll, ...dollRect(doll, s))
    ctx.restore()

    if(title)
    {
        const tw = s * 0.24
        ctx.drawImage(title, s - tw - s * 0.05, s * 0.86, tw, tw * (title.height / title.width))
    }
    return canvas
}

/** Face du disque : sillons + étiquette rose avec la poupée */
const drawRecord = (doll) =>
{
    const s = 1024
    const canvas = document.createElement('canvas')
    canvas.width = canvas.height = s
    const ctx = canvas.getContext('2d')
    const c = s / 2

    ctx.fillStyle = '#0b0a0d'
    ctx.fillRect(0, 0, s, s)

    // sillons : anneaux fins de luminosité variable, avec des plages entre les morceaux
    for(let r = c * 0.36; r < c * 0.97; r += 1.5)
    {
        const gap = Math.sin(r * 0.045) > 0.985
        const v = gap ? 8 : 18 + Math.random() * 14
        ctx.strokeStyle = `rgb(${v}, ${v}, ${v + 4})`
        ctx.lineWidth = 1
        ctx.beginPath()
        ctx.arc(c, c, r, 0, Math.PI * 2)
        ctx.stroke()
    }

    // étiquette, comme le vinyle officiel : fond blanc, grande poupée rose coupée par le bord du rond
    const lr = c * 0.36
    ctx.save()
    ctx.beginPath()
    ctx.arc(c, c, lr, 0, Math.PI * 2)
    ctx.clip()
    ctx.fillStyle = '#f5f3f4'
    ctx.fillRect(c - lr, c - lr, lr * 2, lr * 2)
    const dh = lr * 1.9
    const dw = dh * (doll.width / doll.height)
    ctx.drawImage(doll, c - dw / 2, c - lr * 0.95, dw, dh)
    ctx.restore()

    // trou central
    ctx.fillStyle = '#0e0a10'
    ctx.beginPath()
    ctx.arc(c, c, s * 0.012, 0, Math.PI * 2)
    ctx.fill()
    return canvas
}

export default class Vinyl
{
    constructor(renderer)
    {
        this.group = new THREE.Group()
        this.renderer = renderer

        // ---------------------------------------------- pochette
        const paper = new THREE.MeshStandardMaterial({ color: '#ecebef', roughness: 0.7 })
        // carton mat + poupée vernie en relief : le reflet de la lumière ne glisse que sur la poupée
        this.coverMaterial = new THREE.MeshPhysicalMaterial({
            color: '#ffffff', roughness: 1,
            clearcoat: 1, clearcoatRoughness: 0.06,
            normalScale: new THREE.Vector2(1, 1), clearcoatNormalScale: new THREE.Vector2(1, 1)
        })
        const back = new THREE.MeshStandardMaterial({ color: '#e7c3d6', roughness: 0.7 })
        // ordre des faces d'une BoxGeometry : +x, -x, +y, -y, +z (devant), -z (dos)
        this.sleeve = new THREE.Mesh(
            new THREE.BoxGeometry(SIZE, SIZE, 0.025),
            [paper, paper, paper, paper, this.coverMaterial, back]
        )
        this.sleeve.position.x = OFFSET // décale vers la gauche : pochette + disque sorti restent centrés
        this.group.add(this.sleeve)

        // ---------------------------------------------- disque (derrière la pochette)
        this.recordMaterial = new THREE.MeshPhysicalMaterial({ color: '#ffffff', roughness: 0.6, specularIntensity: 0.15, clearcoat: 0.5, clearcoatRoughness: 0.06, envMapIntensity: 0.35 })
        const edge = new THREE.MeshStandardMaterial({ color: '#111014', roughness: 0.4 })
        const disc = new THREE.Mesh(
            new THREE.CylinderGeometry(DISC_RADIUS, DISC_RADIUS, 0.012, 128),
            [edge, this.recordMaterial, this.recordMaterial] // côté, dessus, dessous
        )
        disc.rotation.x = Math.PI / 2 // la face "dessus" regarde la caméra
        this.disc = new THREE.Group()
        this.disc.add(disc)
        this.disc.position.z = -0.03
        this.group.add(this.disc)

        // ---------------------------------------------- couronne de fréquences autour du disque
        // basses à droite (côté visible), aigus vers la pochette ; symétrique haut / bas
        this.bars = new THREE.InstancedMesh(
            new THREE.BoxGeometry(1, 1, 1),
            new THREE.MeshBasicMaterial({ color: '#ff5fb8', toneMapped: false }),
            BAR_COUNT
        )
        this.bars.position.z = -0.03
        this.bars.frustumCulled = false
        this.group.add(this.bars)
        this.barLevels = new Float32Array(BAR_COUNT)
        this.barBins = Array.from({ length: BAR_COUNT }, (_, i) =>
        {
            const t = i <= BAR_COUNT / 2 ? i / (BAR_COUNT / 2) : (BAR_COUNT - i) / (BAR_COUNT / 2)
            return Math.round(2 * Math.pow(160, t)) // échelle logarithmique : bandes 2 → 320 (~90 Hz → 15 kHz)
        })
        this.dummy = new THREE.Object3D()

        this.slide = 0.12     // sortie du disque (0 = rangé, 1 = sorti)
        this.spin = 0         // angle courant
        this.speed = 0        // vitesse courante (rad/s)

        this.load()
    }

    async load()
    {
        const [doll, title] = await Promise.all([
            loadImage('/images/POUPEE_ROSE.png'),
            loadImage('/images/titre.png').catch(() => null),
            document.fonts?.ready
        ])
        const anisotropy = this.renderer.capabilities.getMaxAnisotropy()

        const cover = new THREE.CanvasTexture(drawCover(doll, title))
        cover.colorSpace = THREE.SRGBColorSpace
        cover.anisotropy = anisotropy
        this.coverMaterial.map = cover

        const surface = drawSurface(doll)
        const linear = (canvas) =>
        {
            const t = new THREE.CanvasTexture(canvas)
            t.anisotropy = anisotropy
            return t
        }
        const normal = linear(surface.normal)
        this.coverMaterial.normalMap = normal
        this.coverMaterial.clearcoatNormalMap = normal
        this.coverMaterial.roughnessMap = linear(surface.roughness)
        this.coverMaterial.clearcoatMap = linear(surface.clearcoat)
        this.coverMaterial.needsUpdate = true

        const record = new THREE.CanvasTexture(drawRecord(doll))
        record.colorSpace = THREE.SRGBColorSpace
        record.anisotropy = anisotropy
        this.recordMaterial.map = record
        this.recordMaterial.needsUpdate = true
    }

    /**
     * @param delta    secondes depuis la dernière image
     * @param out      le disque doit être sorti de la pochette
     * @param spinning le disque tourne
     * @param scratch  décalage du disque dû au scratch, en secondes d'audio (null si pas de scratch)
     */
    update(delta, out, spinning, scratch, spectrum)
    {
        this.updateBars(delta, spectrum)

        // le disque sort quand on joue, rentre à moitié quand on met en pause
        const targetSlide = out ? 1 : 0.12
        this.slide += (targetSlide - this.slide) * (1 - Math.exp(-4 * delta))
        this.disc.position.x = OFFSET + this.slide * SIZE * 0.47

        // vitesse : démarre et freine en douceur, comme une platine
        this.speed += ((spinning ? RPM_SPEED : 0) - this.speed) * (1 - Math.exp(-3 * delta))
        this.spin -= this.speed * delta

        // scratch : on ajoute le va-et-vient (amplifié pour qu'il se voie bien)
        const scratchAngle = scratch === null ? 0 : scratch * RPM_SPEED * 3
        this.disc.rotation.z = this.spin - scratchAngle
        this.bars.position.x = this.disc.position.x
    }

    /** Barres : montent vite, redescendent doucement */
    updateBars(delta, spectrum)
    {
        const d = this.dummy
        for(let i = 0; i < BAR_COUNT; i++)
        {
            const target = spectrum ? Math.pow(spectrum[this.barBins[i]] / 255, 1.6) : 0
            const level = this.barLevels[i]
            this.barLevels[i] = target > level ? level + (target - level) * Math.min(1, delta * 30) : level + (target - level) * Math.min(1, delta * 6)

            const angle = (i / BAR_COUNT) * Math.PI * 2
            const length = 0.01 + this.barLevels[i] * 0.3
            const r = DISC_RADIUS + 0.05 + length / 2
            d.position.set(Math.cos(angle) * r, Math.sin(angle) * r, 0)
            d.rotation.z = angle
            d.scale.set(length, 0.022, 0.012)
            if(this.barLevels[i] < 0.005) d.scale.setScalar(0) // rien à afficher quand la musique est coupée
            d.updateMatrix()
            this.bars.setMatrixAt(i, d.matrix)
        }
        this.bars.instanceMatrix.needsUpdate = true
    }
}
