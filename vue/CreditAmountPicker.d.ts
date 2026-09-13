import type { DefineComponent } from "vue";
import type { CreditPurchaseCatalog, CreditPurchasePreset } from "@absolutejs/billing/credit-purchase";
declare const CreditAmountPicker: DefineComponent<{
  catalog: CreditPurchaseCatalog;
  presets: readonly CreditPurchasePreset[];
  modelValue: number;
  disabled?: boolean;
  "onUpdate:modelValue"?: (amountCents: number) => void;
  onSelect?: (amountCents: number) => void;
}>;
export default CreditAmountPicker;
