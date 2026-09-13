import { expect, test } from "bun:test";
import { createSSRApp, h } from "vue";
import { renderToString } from "vue/server-renderer";
test("published picker uses universal Vue rendering and scoped styles", async () => {
  const path = new URL("../dist/vue/CreditAmountPicker.js", import.meta.url);
  const source = await Bun.file(path).text();
  expect(source).not.toContain("vue/server-renderer");
  const { default: Picker } = await import(path.href);
  const html = await renderToString(createSSRApp({ render: () => h(Picker, { modelValue: 1000, catalog: { minimumCents:1000, maximumCents:100000, stepCents:100, creditsPerCent:1, bonusWindows:[{minimumAmountCents:1000,maximumAmountCents:100000,bonusPercent:0}] }, presets:[{id:"starter",name:"Starter",amountCents:1000}] }) }));
  expect(html).toContain("Credit purchase amount");
  expect(html).toContain("data-v-absolute-credit-picker");
  const css = await Bun.file(new URL("../dist/vue/credit-amount-picker.css", import.meta.url)).text();
  expect(css).toContain("[data-v-absolute-credit-picker]");
});
