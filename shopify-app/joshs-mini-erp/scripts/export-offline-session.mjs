import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

try {
  const shop = process.argv[2]?.trim();
  const session = await prisma.session.findFirst({
    where: {
      ...(shop ? { shop } : {}),
      isOnline: false
    },
    orderBy: {
      id: "asc"
    }
  });

  if (!session) {
    throw new Error(
      shop
        ? `No offline Shopify session found for ${shop}. Keep shopify:dev running, open its Preview URL, and let App Home load once.`
        : "No offline Shopify session found. Keep shopify:dev running, open its Preview URL, and let App Home load once."
    );
  }

  console.log(`SHOPIFY_SHOP_DOMAIN=${session.shop}`);
  console.log(`SHOPIFY_ADMIN_ACCESS_TOKEN=${session.accessToken}`);
  console.log(`SHOPIFY_API_VERSION=2026-07`);
} finally {
  await prisma.$disconnect();
}
