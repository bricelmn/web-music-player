import * as THREE from 'three'
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js'
import Player, { formatTime } from './player.js'
import Vinyl from './vinyl.js'
import Loader from './loader.js'

/**
 * Morceaux, dans l'ordre de la tracklist officielle (l'ordre ici = l'ordre affiché).
 * Chaque morceau = deux pistes dans static/music/stems : <nom>-instru.mp3 et <nom>-voix.mp3
 */
const tracks = [
    { title: 'Poupée parfaite', stem: 'poupee-parfaite' },
    { title: 'Dernière cigarette', stem: 'derniere-cigarette' },
    { title: 'Changer', stem: 'changer' },
    { title: 'Dans tes larmes', stem: 'dans-tes-larmes' },
    { title: 'Perdu dans le décor', stem: 'perdu-dans-le-decor' },
    { title: 'Lâchez nos côtes', stem: 'lachez-nos-cotes' }
].map(t => ({ ...t, instru: `/music/stems/${t.stem}-instru.mp3`, voix: `/music/stems/${t.stem}-voix.mp3` }))

// Réactions sur les temps forts (coup de caméra, flash, particules...) : désactivées pour le moment,
// la détection n'est pas fiable sur tous les passages. Passer à true pour les réactiver.
const BEAT_REACTIONS = false

const player = new Player(tracks)
player.beatsEnabled = BEAT_REACTIONS
if(import.meta.env.DEV) window.player = player // accès depuis la console du navigateur, en développement uniquement

/**
 * Interface : liste des morceaux + lecteur
 */
const list = document.querySelector('.tracklist')
const items = tracks.map((track, i) =>
{
    const li = document.createElement('li')
    li.className = 'track'
    li.innerHTML = `<span class="num">${String(i + 1).padStart(2, '0')}</span><span class="name"></span><span class="dur"></span>`
    li.querySelector('.name').textContent = track.title
    li.addEventListener('click', () => player.select(i))
    list.appendChild(li)

    // durée de chaque morceau
    const probe = new Audio()
    probe.preload = 'metadata'
    probe.src = track.instru
    probe.addEventListener('loadedmetadata', () =>
    {
        track.duration = probe.duration
        li.querySelector('.dur').textContent = formatTime(probe.duration)
        updateUI()
    })
    return li
})

const playButton = document.querySelector('.btn.play')
const muteButton = document.querySelector('.btn.mute')
const seek = document.querySelector('.seek')
const timeCurrent = document.querySelector('.time.current')
const timeTotal = document.querySelector('.time.total')
let seeking = false

playButton.addEventListener('click', () => player.toggle())
muteButton.addEventListener('click', () => player.toggleMute())
seek.addEventListener('input', () =>
{
    seeking = true
    seek.style.setProperty('--p', `${seek.value / 10}%`)
    timeCurrent.textContent = formatTime(seek.value / 1000 * trackDuration())
})
seek.addEventListener('change', () =>
{
    player.seek(seek.value / 1000)
    seeking = false
})

// durée connue avant même le chargement du morceau (lue dans les métadonnées)
const trackDuration = () => player.duration || tracks[player.index].duration || 0

// Original / Instru / Voix
const modeButtons = [...document.querySelectorAll('.modes button')]
modeButtons.forEach(b => b.addEventListener('click', () => player.setMode(b.dataset.mode)))

function updateUI()
{
    items.forEach((li, i) => li.classList.toggle('active', i === player.index))
    playButton.classList.toggle('playing', player.playing || player.switching || player.loading)
    playButton.classList.toggle('loading', player.loading)
    playButton.setAttribute('aria-label', player.playing ? 'Pause' : 'Lecture')
    muteButton.classList.toggle('muted', player.muted)
    muteButton.setAttribute('aria-label', player.muted ? 'Remettre le son' : 'Couper le son')
    modeButtons.forEach(b =>
    {
        b.classList.toggle('active', b.dataset.mode === player.mode)
        b.setAttribute('aria-pressed', b.dataset.mode === player.mode)
    })

    const currentTime = player.currentTime
    const duration = trackDuration()
    timeTotal.textContent = formatTime(duration)
    if(!seeking)
    {
        const ratio = duration ? currentTime / duration : 0
        seek.value = ratio * 1000
        seek.style.setProperty('--p', `${ratio * 100}%`)
        timeCurrent.textContent = formatTime(currentTime)
    }
}
player.addEventListener('update', updateUI)
player.addEventListener('track', updateUI)
player.addEventListener('mode', updateUI)
updateUI()

// barre d'espace = lecture / pause, M = mute, 1 / 2 / 3 = original / instru / voix
window.addEventListener('keydown', (e) =>
{
    if(e.code === 'Space' && e.target === document.body) { e.preventDefault(); player.toggle() }
    if(e.key === 'm' || e.key === 'M') player.toggleMute()
    const mode = { 1: 'original', 2: 'instru', 3: 'voix' }[e.key]
    if(mode) player.setMode(mode)
})

/**
 * Scène 3D
 */
const canvas = document.querySelector('canvas.webgl')
const scene = new THREE.Scene()

const sizes = { width: window.innerWidth, height: window.innerHeight }

const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true })
renderer.setSize(sizes.width, sizes.height)
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
renderer.toneMapping = THREE.NeutralToneMapping

const pmrem = new THREE.PMREMGenerator(renderer)
scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture
scene.environmentIntensity = 0.55 // ambiance plus sombre : les lumières ci-dessous font le travail

const keyLight = new THREE.DirectionalLight('#ffd6ec', 1.2)
keyLight.position.set(2, 3, 4)
scene.add(keyLight)

// Caméra dans un groupe : le groupe suit la souris (parallaxe), comme dans le cours
const cameraGroup = new THREE.Group()
scene.add(cameraGroup)
const camera = new THREE.PerspectiveCamera(35, sizes.width / sizes.height, 0.1, 100)
const CAMERA_DISTANCE = 6
camera.position.z = CAMERA_DISTANCE
cameraGroup.add(camera)

/**
 * Pochette vinyle
 */
const logoGroup = new THREE.Group()
scene.add(logoGroup)
const vinyl = new Vinyl(renderer)

/**
 * Écran de chargement : attend la police, les textures de la pochette et le premier morceau.
 * Le clic sur "Écouter" lance la musique pile au moment où la scène apparaît.
 */
const loader = new Loader(document.querySelector('.loader'))
let fontsLoaded = !document.fonts
document.fonts?.ready.then(() => { fontsLoaded = true })
loader.add('police', 1, () => fontsLoaded ? 1 : 0)
loader.add('pochette', 3, () => vinyl.loaded ? 1 : 0)
loader.add('premier morceau', 6, () => player.loadProgress(0))

// entrée dans la scène : la caméra arrive en douceur depuis un peu plus loin
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
let introStart = null
loader.done.then((choice) =>
{
    introStart = performance.now()
    if(choice === 'listen') player.play()
})
const logo = vinyl.group
logoGroup.add(logo)

/**
 * Lumières de la pochette (enfants de logoGroup : elles suivent sa position et sa taille)
 * - une lampe qui suit la souris : son reflet glisse sur la poupée vernie
 * - un halo rose derrière le vinyle, qui pulse sur les basses
 */
const cursorLight = new THREE.PointLight('#fff4fa', 3.5, 0, 2)
cursorLight.position.set(0, 0, 1.6)
logoGroup.add(cursorLight)

const haloCanvas = document.createElement('canvas')
haloCanvas.width = haloCanvas.height = 256
const haloCtx = haloCanvas.getContext('2d')
const haloGradient = haloCtx.createRadialGradient(128, 128, 0, 128, 128, 128)
haloGradient.addColorStop(0, 'rgba(255, 255, 255, 1)')
haloGradient.addColorStop(0.4, 'rgba(255, 255, 255, 0.35)')
haloGradient.addColorStop(1, 'rgba(255, 255, 255, 0)')
haloCtx.fillStyle = haloGradient
haloCtx.fillRect(0, 0, 256, 256)
const halo = new THREE.Mesh(
    new THREE.PlaneGeometry(3.8, 3.8),
    new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(haloCanvas), transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, opacity: 0.25 })
)
halo.position.set(0.2, 0, -0.8)
halo.material.color.set('#ff46aa')
logoGroup.add(halo)

/**
 * Particules
 */
const particlesCount = 400
const positions = new Float32Array(particlesCount * 3)
for(let i = 0; i < particlesCount; i++)
{
    positions[i * 3 + 0] = (Math.random() - 0.5) * 14
    positions[i * 3 + 1] = (Math.random() - 0.5) * 9
    positions[i * 3 + 2] = (Math.random() - 0.5) * 6 - 1
}
const particlesGeometry = new THREE.BufferGeometry()
particlesGeometry.setAttribute('position', new THREE.BufferAttribute(positions, 3))
const particles = new THREE.Points(
    particlesGeometry,
    new THREE.PointsMaterial({ color: '#ff8fcb', size: 0.025, sizeAttenuation: true, transparent: true, opacity: 0.7, depthWrite: false })
)
scene.add(particles)

/**
 * Triangle 3D qui désigne le morceau courant
 */
const triangle = new THREE.Mesh(
    new THREE.ConeGeometry(0.075, 0.16, 3),
    new THREE.MeshStandardMaterial({ color: '#e0479e', emissive: '#e0479e', emissiveIntensity: 0.35, roughness: 0.25, metalness: 0.1, flatShading: true })
)
triangle.rotation.z = -Math.PI / 2 // la pointe vers la droite, vers le titre
// toujours dessiné par-dessus le reste de la scène : il ne peut jamais passer derrière le vinyle
triangle.material.depthTest = false
triangle.renderOrder = 10
const triangleHolder = new THREE.Group()
triangleHolder.add(triangle)
scene.add(triangleHolder)

const raycaster = new THREE.Raycaster()
const plane = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0)
const triangleTarget = new THREE.Vector3()
const ndc = new THREE.Vector2()

/** Point du monde (plan z=0) qui se trouve sous le pixel (x, y) de l'écran */
const screenToWorld = (x, y, target) =>
{
    ndc.set((x / sizes.width) * 2 - 1, -(y / sizes.height) * 2 + 1)
    raycaster.setFromCamera(ndc, camera)
    return raycaster.ray.intersectPlane(plane, target)
}

/**
 * Mise en page : le vinyle occupe la zone libre à gauche de la tracklist (au-dessus sur mobile).
 * La zone est mesurée sur la vraie position de la liste, pour que le disque sorti ne la touche jamais.
 */
const VINYL_WIDTH = 3.6   // pochette + disque sorti + couronne de fréquences, en unités (avant mise à l'échelle)
const VINYL_HEIGHT = 2
const SAFETY = 0.8        // marge pour la rotation vers la souris et le battement sur les basses

const layout = () =>
{
    const mobile = sizes.width <= 760
    const panel = document.querySelector('.panel').getBoundingClientRect()

    // zone libre, en pixels
    const zone = mobile
        ? { left: 0, right: sizes.width, top: 0, bottom: panel.top }
        : { left: 0, right: panel.left - 24, top: 0, bottom: sizes.height } // 24 px : place du triangle

    // on calcule toujours avec la caméra à sa place normale (pendant l'intro, elle arrive de plus loin)
    const cameraZ = camera.position.z
    camera.position.z = CAMERA_DISTANCE
    camera.updateMatrixWorld()
    const p = screenToWorld((zone.left + zone.right) / 2, (zone.top + zone.bottom) / 2, new THREE.Vector3())
    if(p) logoGroup.position.set(p.x - cameraGroup.position.x, p.y - cameraGroup.position.y, 0)
    camera.position.z = cameraZ
    camera.updateMatrixWorld()

    // taille : le vinyle tient dans la zone, marge comprise
    const visibleHeight = 2 * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) * CAMERA_DISTANCE
    const unitsPerPixel = visibleHeight / sizes.height
    const byWidth = ((zone.right - zone.left) * unitsPerPixel * SAFETY) / VINYL_WIDTH
    const byHeight = ((zone.bottom - zone.top) * unitsPerPixel * (mobile ? 0.75 : 0.62)) / VINYL_HEIGHT
    logoGroup.scale.setScalar(Math.min(byHeight, byWidth))
}

window.addEventListener('resize', () =>
{
    sizes.width = window.innerWidth
    sizes.height = window.innerHeight
    camera.aspect = sizes.width / sizes.height
    camera.updateProjectionMatrix()
    renderer.setSize(sizes.width, sizes.height)
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    layout()
})
layout()
// la liste change de taille quand la police et le titre finissent de charger : on recalcule
new ResizeObserver(layout).observe(document.querySelector('.panel'))
window.addEventListener('load', layout)

/**
 * Curseur
 */
const cursor = { x: 0, y: 0 }
window.addEventListener('mousemove', (event) =>
{
    cursor.x = event.clientX / sizes.width - 0.5
    cursor.y = event.clientY / sizes.height - 0.5
})

/**
 * Animation
 */
const timer = new THREE.Timer()
let bassSmooth = 0
let kick = 0 // 1 au moment d'un temps fort, puis redescend vers 0

// couleur du halo et de la couronne selon ce qu'on écoute
const MODE_COLORS = { original: new THREE.Color('#ff46aa'), instru: new THREE.Color('#9a6bff'), voix: new THREE.Color('#45d4ff') }
let firstFrame = true

const tick = () =>
{
    timer.update()
    const elapsed = timer.getElapsed()
    const delta = Math.min(timer.getDelta(), 0.1)

    // parallaxe
    const parallaxX = cursor.x * 0.5
    const parallaxY = -cursor.y * 0.5
    cameraGroup.position.x += (parallaxX - cameraGroup.position.x) * 5 * delta
    cameraGroup.position.y += (parallaxY - cameraGroup.position.y) * 5 * delta

    // pochette : flotte, suit un peu la souris, pulse légèrement sur les basses
    const audio = player.analyse()
    bassSmooth += (audio.bass - bassSmooth) * 12 * delta
    if(BEAT_REACTIONS && audio.beat) kick = 0.35 + 0.65 * audio.strength // les temps les plus marqués tapent plus fort
    kick *= Math.exp(-7 * delta)

    // temps fort : la caméra donne un petit coup en avant
    const intro = introStart === null ? 0 : reducedMotion ? 1 : Math.min(1, (performance.now() - introStart) / 1800)
    const introEase = 1 - Math.pow(1 - intro, 3)
    camera.position.z = CAMERA_DISTANCE + (1 - introEase) * 2.5 - kick * 0.15
    logo.rotation.y = Math.sin(elapsed * 0.6) * 0.15 + cursor.x * 0.35
    logo.rotation.x = cursor.y * 0.2

    // la lampe suit la souris devant la pochette ; le halo respire avec les basses
    cursorLight.position.x += (cursor.x * 4 - 0.5 - cursorLight.position.x) * (1 - Math.exp(-6 * delta))
    cursorLight.position.y += (-cursor.y * 3 - cursorLight.position.y) * (1 - Math.exp(-6 * delta))
    halo.material.opacity = 0.15 + bassSmooth * 0.6 + kick * 0.35
    cursorLight.intensity = 3.5 + kick * 6 // flash sur le vernis de la poupée
    halo.scale.setScalar(1 + bassSmooth * 0.15)
    const modeColor = MODE_COLORS[player.mode]
    halo.material.color.lerp(modeColor, 1 - Math.exp(-5 * delta))
    vinyl.bars.material.color.lerp(modeColor, 1 - Math.exp(-5 * delta))
    logo.position.y = Math.sin(elapsed * 1.2) * 0.04
    logo.scale.setScalar(1 + bassSmooth * 0.03 + kick * 0.025)

    // vinyle : sort quand on joue, s'arrête net pendant le scratch (la main est sur le disque)
    vinyl.update(delta, player.playing || player.switching, player.playing && !player.switching, player.getScratchOffset(), audio.spectrum)

    // particules : grossissent à chaque temps fort
    particles.rotation.y = elapsed * 0.02
    particles.material.size = 0.025 * (1 + kick * 1.4)

    // triangle : se place à gauche du titre courant (recalculé à chaque image, car la caméra bouge)
    camera.updateMatrixWorld()
    const rect = items[player.index].getBoundingClientRect()
    if(screenToWorld(rect.left + 12,rect.top + rect.height / 2, triangleTarget))
    {
        if(firstFrame) triangleHolder.position.copy(triangleTarget)
        triangleHolder.position.lerp(triangleTarget, 1 - Math.exp(-10 * delta))
    }
    triangle.rotation.x = elapsed * 2.5
    triangleHolder.scale.setScalar(1 + bassSmooth * 0.2 + kick * 0.35)
    firstFrame = false

    renderer.render(scene, camera)
    window.requestAnimationFrame(tick)
}
tick()
