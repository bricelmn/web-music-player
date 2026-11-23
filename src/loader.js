/**
 * Écran de chargement : la poupée se remplit de rose au rythme du vrai chargement.
 *
 * On lui donne des "tâches" (police, textures de la pochette, premier morceau...), chacune avec un poids
 * et une fonction qui renvoie sa progression (0 → 1). Quand tout est prêt, le bouton "Écouter" apparaît.
 *
 *   const loader = new Loader(document.querySelector('.loader'))
 *   loader.add('textures', 3, () => vinyl.loaded ? 1 : 0)
 *   const choice = await loader.done   // 'listen' ou 'silent'
 */
const MIN_DURATION = 1200 // ms : même en cache, on laisse le temps de voir la poupée se remplir

export default class Loader
{
    constructor(element)
    {
        this.element = element
        this.fill = element.querySelector('.loader-doll-fill')
        this.percent = element.querySelector('.loader-percent')
        this.tasks = []
        this.shown = 0 // progression affichée (suit la vraie en douceur)
        this.start = performance.now()

        this.done = new Promise((resolve) =>
        {
            const choose = (choice) => () =>
            {
                this.element.classList.add('hidden')
                resolve(choice)
            }
            element.querySelector('.loader-listen').addEventListener('click', choose('listen'))
            element.querySelector('.loader-silent').addEventListener('click', choose('silent'))
        })

        this.tick = this.tick.bind(this)
        requestAnimationFrame(this.tick)
    }

    /** Ajoute une tâche : progress() renvoie un nombre entre 0 et 1 */
    add(name, weight, progress)
    {
        this.tasks.push({ name, weight, progress })
    }

    get progress()
    {
        const total = this.tasks.reduce((sum, t) => sum + t.weight, 0) || 1
        const done = this.tasks.reduce((sum, t) => sum + t.weight * Math.min(1, Math.max(0, t.progress() || 0)), 0)
        // la durée minimale compte comme une tâche : impossible d'afficher 100 % trop tôt
        const time = Math.min(1, (performance.now() - this.start) / MIN_DURATION)
        return Math.min(done / total, time)
    }

    tick()
    {
        const target = this.progress
        // la poupée se remplit en douceur, sans jamais dépasser la vraie progression
        this.shown += (target - this.shown) * 0.12
        if(target >= 1 && this.shown > 0.995) this.shown = 1

        this.fill.style.setProperty('--p', this.shown.toFixed(4))
        this.percent.textContent = Math.floor(this.shown * 100)

        if(this.shown >= 1)
        {
            this.element.classList.add('ready')
            this.element.querySelector('.loader-listen').focus({ preventScroll: true })
            return
        }
        requestAnimationFrame(this.tick)
    }
}
