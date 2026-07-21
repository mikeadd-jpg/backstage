// The Shopify-first resolver. Core business logic:
//   1. Look up the order in Shopify (source of truth).
//   2. Build a per-line-item ledger from Shopify's fulfillment data.
//   3. Only for items still unshipped by a print vendor, drill into that vendor.
//   4. Flag the order for action when a manually fulfilled item has not shipped.
// Also provides a cross-brand lookup: given an order number, find which store owns it.
import { findOrder, buildLedger } from './shopify.js';
import { brandConfig, configuredShopifyBrands } from './brands.js';
import { getProductionStatus as printifyStatus } from './printify.js';
import { getProductionStatus as gelatoStatus } from './gelato.js';

function shopifyAdminUrl(brand, orderId) {
  const { shopify } = brandConfig(brand);
  if (!shopify.domain || !orderId) return null;
  const handle = shopify.domain.replace('.myshopify.com', '');
  return 'https://admin.shopify.com/store/' + handle + '/orders/' + orderId;
}

export async function resolveOrderStatus(brand, { orderNumber, email }) {
  const order = await findOrder(brand, { orderNumber, email });
  if (!order) {
    return { found: false, orderNumber, items: [], needsAction: false };
  }

  const items = buildLedger(order);
  const { printifyShopId } = brandConfig(brand);

  await Promise.all(
    items.map(async (it) => {
      if (it.status !== 'production') return;
      try {
        if (it.fulfiller === 'printify' && printifyShopId) {
          const d = await printifyStatus(printifyShopId, order.id);
          if (d) { it.vendorDetail = d; it.vendorLink = d.link; }
        } else if (it.fulfiller === 'gelato') {
          const d = await gelatoStatus(order.id);
          if (d) { it.vendorDetail = d; it.vendorLink = d.link; }
        }
      } catch {
        // Vendor lookups are best-effort. Shopify status still stands if they fail.
      }
    })
  );

  return {
    found: true,
    brand,
    orderId: order.id,
    orderNumber: order.name,
    placedAt: order.created_at,
    financialStatus: order.financial_status,
    customerEmail: order.email,
    customerFirstName: (order.customer && order.customer.first_name) || null,
    shopifyAdminUrl: shopifyAdminUrl(brand, order.id),
    items,
    needsAction: items.some((it) => it.status === 'action'),
  };
}

// When brand routing failed or the routed store does not have the order, use the order
// number (or email) as the context clue: try each configured store until one matches.
// The matching store IS the brand.
export async function resolveOrderAcrossBrands({ orderNumber, email }, exclude = []) {
  for (const brand of configuredShopifyBrands()) {
    if (exclude.includes(brand)) continue;
    try {
      const status = await resolveOrderStatus(brand, { orderNumber, email });
      if (status.found) return { brand, status };
    } catch {
      // skip a store that errors, keep trying the rest
    }
  }
  return null;
}
