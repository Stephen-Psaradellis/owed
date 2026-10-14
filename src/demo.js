// "Run demo": four fictional clients, written the way a freelancer would actually paste
// them, at four different points in the collections cycle. All names, emails and
// amounts are invented; every email uses the reserved .test domain.

export const DEMO_CLIENTS = [
  {
    key: 'acme.test',
    issuedDaysAgo: 0,
    history: { invoices: 0, paidLate: 0, avgDaysLate: 0 },
    story: 'New client, invoice goes out today.',
    brief: 'Built the Shopify theme for Acme Outfitters, $1,800, net 15, contact jo@acme.test',
  },
  {
    key: 'brightlinedental.test',
    issuedDaysAgo: 38,
    history: { invoices: 3, paidLate: 2, avgDaysLate: 12 },
    story: 'Has paid late before; this invoice is now overdue.',
    brief: [
      'From: Dana Whitfield <dana@brightlinedental.test>',
      'Subject: Re: Website refresh - final files',
      '',
      'Hi Sam, the new site looks great, thank you! Send the invoice whenever you are ready',
      'and I will pass it to our bookkeeper.',
      '',
      'Dana Whitfield',
      'Office Manager, Brightline Dental',
      '',
      '> Website refresh: 6 pages + booking widget, $2,150. Hosting setup $250. Net 30.',
    ].join('\n'),
  },
  {
    key: 'juniperandrye.test',
    issuedDaysAgo: 5,
    history: { invoices: 4, paidLate: 1, avgDaysLate: 4 },
    story: 'Pays through PayPal during the demo, so its reminders stop.',
    brief: 'Logo refresh + brand kit for Juniper & Rye Bakery - 12 hours at $55/hr. Due in 7 days. Billing: priya@juniperandrye.test',
    paysDuringDemo: true,
  },
  {
    key: 'northwindlabs.test',
    issuedDaysAgo: 20,
    history: { invoices: 5, paidLate: 0, avgDaysLate: 0 },
    story: 'Reliable payer, large retainer, not yet due.',
    brief: 'October retainer for Northwind Labs: product design support, $4,500, net 30. AP contact: ap@northwindlabs.test (Marcus Lee)',
  },
];

export const SAMPLE_PROMPTS = [
  'Who owes me what?',
  "What's overdue?",
  'Built a landing page for Fernhill Yoga, $950, due in 10 days, contact mia@fernhillyoga.test',
  'Check payments',
];
