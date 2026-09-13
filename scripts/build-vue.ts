import { parse, compileScript, compileStyle } from "@vue/compiler-sfc";
const source = await Bun.file("vue/CreditAmountPicker.vue").text();
const { descriptor, errors } = parse(source, { filename: "CreditAmountPicker.vue" });
if (errors.length) throw Error(String(errors));
const id = "data-v-absolute-credit-picker";
const script = compileScript(descriptor, { id, inlineTemplate: true, genDefaultAs: "component" });
const temporary = new URL("../vue/.creditAmountPicker.generated.ts", import.meta.url).pathname;
try {
  await Bun.write(temporary, script.content + `\ncomponent.__scopeId = "${id}";\nexport default component;\n`);
  const build = await Bun.build({ entrypoints: [temporary], target: "browser", external: ["vue", "@absolutejs/billing/credit-purchase"], minify: false });
  if (!build.success) throw Error(String(build.logs));
  await Bun.write("dist/vue/CreditAmountPicker.js", await build.outputs[0]!.text());
  const styles = descriptor.styles.map(style => {
    const result = compileStyle({ source: style.content, filename: "CreditAmountPicker.vue", id, scoped: true });
    if (result.errors.length) throw Error(String(result.errors));
    return result.code;
  });
  await Bun.write("dist/vue/credit-amount-picker.css", styles.join("\n"));
  await Bun.write("dist/vue/CreditAmountPicker.d.ts", Bun.file("vue/CreditAmountPicker.d.ts"));
} finally { await Bun.file(temporary).delete(); }
