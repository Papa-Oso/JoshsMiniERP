import type { LoaderFunctionArgs } from "react-router";
import { Form, redirect, useLoaderData } from "react-router";

import { login } from "../../shopify.server";

import styles from "./styles.module.css";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);
  const shop = url.searchParams.get("shop");

  if (shop) {
    throw redirect(`/app?${url.searchParams.toString()}`);
  }

  return {
    showForm: Boolean(login),
    defaultShop: process.env.SHOPIFY_DEV_STORE ?? "",
  };
};

export default function App() {
  const { defaultShop, showForm } = useLoaderData<typeof loader>();

  return (
    <main className={styles.index}>
      <section className={styles.content}>
        <h1 className={styles.heading}>Josh&apos;s Mini ERP</h1>
        <p className={styles.text}>Open the embedded inventory sync app.</p>
        {showForm ? (
          <Form className={styles.form} method="post" action="/auth/login">
            <label className={styles.label}>
              <span>Shop domain</span>
              <input
                className={styles.input}
                type="text"
                name="shop"
                defaultValue={defaultShop}
                placeholder="aqrqyf-uw.myshopify.com"
              />
            </label>
            <button className={styles.button} type="submit">
              Open app
            </button>
          </Form>
        ) : null}
      </section>
    </main>
  );
}
