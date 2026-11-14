const dark = matchMedia('(prefers-color-scheme: dark)')
const scheme = () => {
  document.getElementById('scheme').textContent = `dark ${dark.matches}`
}
dark.addEventListener('change', scheme)
scheme()
document.getElementById('press').addEventListener('click', (event) => {
  event.target.textContent = 'Pressed'
})
document.getElementById('name').addEventListener('input', (event) => {
  document.getElementById('typed').textContent = `typed ${event.target.value}`
})
document.getElementById('name').addEventListener('keydown', (event) => {
  if (event.key === 'Enter') {
    document.getElementById('typed').textContent = `entered ${event.target.value}`
  }
})
