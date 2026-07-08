import { useEffect, useState } from "react";
import type { LoaderFunctionArgs } from "react-router";
import { useLoaderData } from "react-router";

export const loader = ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);

  return {
    error: url.searchParams.get("error"),
    errorDescription: url.searchParams.get("error_description"),
    hasCode: Boolean(url.searchParams.get("code")),
    hasState: Boolean(url.searchParams.get("state"))
  };
};

export default function EtsyCallback() {
  const { error, errorDescription, hasCode, hasState } = useLoaderData<typeof loader>();
  const [currentUrl, setCurrentUrl] = useState("");
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    setCurrentUrl(window.location.href);
  }, []);

  async function copyUrl() {
    await navigator.clipboard.writeText(currentUrl);
    setCopied(true);
  }

  const ready = hasCode && hasState;

  return (
    <main
      style={{
        alignItems: "center",
        background: "#f6f3ee",
        color: "#171412",
        display: "flex",
        fontFamily: "Inter, system-ui, sans-serif",
        justifyContent: "center",
        minHeight: "100vh",
        padding: "24px"
      }}
    >
      <section style={{ maxWidth: "720px", width: "100%" }}>
        <p style={{ color: "#706a62", fontSize: "14px", margin: "0 0 8px" }}>Josh&apos;s Mini ERP</p>
        <h1 style={{ fontSize: "32px", lineHeight: 1.1, margin: "0 0 12px" }}>Etsy authorization returned</h1>
        {error ? (
          <p style={{ fontSize: "16px", lineHeight: 1.5, margin: "0 0 20px" }}>
            Etsy returned an authorization error: {errorDescription ?? error}
          </p>
        ) : ready ? (
          <p style={{ fontSize: "16px", lineHeight: 1.5, margin: "0 0 20px" }}>
            Copy this full URL and paste it into the local Etsy callback command.
          </p>
        ) : (
          <p style={{ fontSize: "16px", lineHeight: 1.5, margin: "0 0 20px" }}>
            This URL does not include the Etsy authorization code yet.
          </p>
        )}
        <textarea
          readOnly
          value={currentUrl}
          style={{
            background: "#fff",
            border: "1px solid #d8d0c5",
            borderRadius: "6px",
            boxSizing: "border-box",
            color: "#171412",
            fontFamily: "Consolas, monospace",
            fontSize: "13px",
            minHeight: "128px",
            padding: "12px",
            resize: "vertical",
            width: "100%"
          }}
        />
        <button
          disabled={!currentUrl}
          onClick={copyUrl}
          style={{
            background: "#171412",
            border: 0,
            borderRadius: "6px",
            color: "#fff",
            cursor: currentUrl ? "pointer" : "default",
            fontSize: "14px",
            fontWeight: 700,
            marginTop: "14px",
            opacity: currentUrl ? 1 : 0.5,
            padding: "10px 14px"
          }}
          type="button"
        >
          {copied ? "Copied" : "Copy URL"}
        </button>
      </section>
    </main>
  );
}
