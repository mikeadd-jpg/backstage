// Gelato drill-down. Same idea as Printify: only for unshipped Gelato line items.

export async function getProductionStatus(shopifyOrderId) {
  const key = process.env.GELATO_API_KEY;
  if (!key) return null;

  const res = await fetch(
    'https://order.gelatoapis.com/v4/orders?orderReferenceId=' + encodeURIComponent(shopifyOrderId),
    { headers: { 'X-API-KEY': key } }
  );
  if (!res.ok) return null;
  const data = await res.json();
  const order = (data.orders || data.data || [])[0];
  if (!order) return null;

  return {
    vendor: 'gelato',
    status: order.fulfillmentStatus || order.status,
    shipments: (order.shipment ? [order.shipment] : []).map((s) => ({
      carrier: s.shipmentMethodName,
      tracking: s.trackingCode,
    })),
    link: 'https://dashboard.gelato.com/orders',
  };
}
