import type { Locator } from 'playwright'

export async function chooseFactory(dialog: Locator, name: string) {
  await dialog.getByRole('combobox', { name: 'Factory', exact: true }).click()
  await dialog
    .getByRole('listbox', { name: 'Factory', exact: true })
    .getByRole('option', { name, exact: true })
    .click()
}
