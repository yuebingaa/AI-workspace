/** Select through the actual popup, including keyboard focus and controlled callbacks. */
export async function chooseUiOption(page, trigger, value) {
  if (await trigger.evaluate(element => element.tagName === 'SELECT')) return trigger.selectOption(value);
  await trigger.click();
  const options = page.getByRole('option');
  await options.first().waitFor();
  for (const option of await options.all()) {
    if (await option.getAttribute('data-value') === value) { await option.click(); return; }
  }
  throw new Error(`No selectable option with value ${value}`);
}
