import type Stripe from "stripe";

/** Read-only check; an override only permits the no-registration condition. */
export async function checkTaxReadiness(
  stripe: Stripe,
  allowNoRegistration: boolean,
  warn: (message: string) => void,
) {
  const [settings, registrations] = await Promise.all([
    stripe.tax.settings.retrieve(),
    stripe.tax.registrations.list({ status: "active", limit: 1 }),
  ]);
  if (
    settings.status !== "active" ||
    settings.head_office === null ||
    !settings.head_office.address.country
  )
    throw new Error(
      "Stripe Tax is not active or the head-office address is missing",
    );
  if (registrations.data.length === 0) {
    warn("no tax registrations: Stripe Tax will compute 0 VAT");
    if (!allowNoRegistration)
      throw new Error(
        "Add tax registrations before enabling automatic tax, or explicitly override",
      );
  }
}
