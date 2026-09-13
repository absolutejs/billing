<script setup lang="ts">
import { computed, useId } from "vue";
import { quoteCreditAmount, type CreditPurchaseCatalog, type CreditPurchasePreset } from "@absolutejs/billing/credit-purchase";
const props = defineProps<{ catalog: CreditPurchaseCatalog; presets: readonly CreditPurchasePreset[]; modelValue: number; disabled?: boolean }>();
const emit = defineEmits<{ "update:modelValue": [number]; select: [number] }>();
const id = useId();
const quote = computed(() => quoteCreditAmount(props.catalog, props.modelValue));
const dollars = computed({ get: () => props.modelValue / 100, set: (value: number) => emit("update:modelValue", value * 100) });
const money = (cents: number) => (cents / 100).toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
const select = (amount: number) => { if (props.disabled) return; emit("update:modelValue", amount); emit("select", amount); };
</script>
<template>
  <section class="credit-picker" aria-label="Choose credit purchase amount">
    <div class="picker-heading"><div><h2>Choose your amount</h2><p>One-time top-up. No subscription.</p></div>
      <label :for="id">Amount ($)<input :id="id" v-model.number="dollars" type="number" inputmode="numeric" :min="catalog.minimumCents / 100" :max="catalog.maximumCents / 100" :step="catalog.stepCents / 100" :disabled="disabled" :aria-invalid="!quote" /></label>
    </div>
    <input v-model.number="dollars" class="picker-slider" type="range" aria-label="Credit purchase amount" :aria-valuetext="money(modelValue)" :min="catalog.minimumCents / 100" :max="catalog.maximumCents / 100" :step="catalog.stepCents / 100" :disabled="disabled" />
    <div class="picker-limits" aria-hidden="true"><span>{{ money(catalog.minimumCents) }}</span><span>{{ money(catalog.maximumCents) }}</span></div>
    <div class="picker-presets"><button v-for="preset in presets" :key="preset.id" type="button" :disabled="disabled" :aria-pressed="modelValue === preset.amountCents" @click="select(preset.amountCents)"><span>{{ preset.name }}</span><strong>{{ money(preset.amountCents) }}</strong><span>{{ quoteCreditAmount(catalog, preset.amountCents)?.credits.toLocaleString() }} credits</span><span v-if="quoteCreditAmount(catalog, preset.amountCents)?.bonusPercent" class="picker-bonus">+{{ quoteCreditAmount(catalog, preset.amountCents)?.bonusPercent }}% bonus</span></button></div>
    <p v-if="quote" class="picker-total" aria-live="polite">You receive <strong>{{ quote.credits.toLocaleString() }} credits</strong><span v-if="quote.bonusPercent"> · Includes +{{ quote.bonusPercent }}% bonus</span></p>
    <p v-else role="alert">Choose a whole-dollar amount from {{ money(catalog.minimumCents) }} to {{ money(catalog.maximumCents) }}.</p>
    <button class="picker-continue" type="button" :disabled="disabled || !quote" @click="select(modelValue)">Continue with {{ quote ? money(modelValue) : "amount" }}</button>
  </section>
</template>
<style scoped>
.credit-picker{padding:24px;border:1px solid var(--color-border-strong,#d1d5db);border-radius:18px;background:var(--color-bg-card,#fff);color:var(--color-fg-primary,#111827)}
.picker-heading,.picker-limits{display:flex;justify-content:space-between;gap:16px}.picker-heading h2{margin:0;font-size:1.2rem}.picker-heading p,.picker-total{font-size:.9rem}.picker-heading label{display:grid;gap:6px;font-size:.85rem}.picker-heading input{width:7rem;padding:10px;border:1px solid var(--color-border-strong,#d1d5db);border-radius:10px;background:var(--color-bg-card,#fff);color:inherit}.picker-slider{display:block;width:100%;min-height:44px;accent-color:var(--color-accent-primary,#ba8e35)}.picker-limits{font-size:.8rem;opacity:.8}.picker-presets{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px;margin:20px 0}.picker-presets button{display:grid;gap:5px;text-align:left;padding:14px;border:1px solid var(--color-border-strong,#d1d5db);border-radius:12px;background:var(--color-bg-card,#fff);color:inherit;cursor:pointer}.picker-presets button[aria-pressed=true]{border-color:var(--color-accent-primary,#ba8e35);box-shadow:inset 0 0 0 1px var(--color-accent-primary,#ba8e35)}.picker-presets strong{font-size:1.3rem}.picker-presets span{font-size:.8rem}.picker-bonus{color:var(--color-accent-primary,#ba8e35)}.picker-continue{width:100%;min-height:44px;border:0;border-radius:10px;background:var(--color-accent-primary,#ba8e35);color:var(--color-fg-on-accent,#101218);font-weight:650;padding:12px;cursor:pointer}button:disabled{opacity:.5;cursor:not-allowed}input:focus-visible,button:focus-visible{outline:2px solid var(--color-accent-primary,#ba8e35);outline-offset:3px}@media(max-width:480px){.credit-picker{padding:16px}.picker-heading{flex-direction:column}.picker-presets{gap:6px}.picker-presets button{padding:10px}}
</style>
