import { AppProvider } from "@shopify/shopify-app-react-router/react";
import { useEffect } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { useActionData, useLoaderData } from "react-router";

import { login } from "../../shopify.server";
import { loginErrorMessage } from "./error.server";
import styles from "./authLogin.module.css";

/** If login() threw a redirect to oauth/install, return the URL so the client can redirect (top window). */
function getInstallRedirectUrl(error: unknown): string | null {
  const res = error instanceof Response ? error : null;
  if (!res || res.status !== 302) return null;
  const location = res.headers.get("Location");
  if (!location || !location.includes("oauth/install")) return null;
  return location;
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  try {
    const errors = loginErrorMessage(await login(request));
    return { errors };
  } catch (error) {
    const redirectUrl = getInstallRedirectUrl(error);
    if (redirectUrl) return { errors: {}, redirectUrl };
    throw error;
  }
};

export const action = async ({ request }: ActionFunctionArgs) => {
  try {
    const errors = loginErrorMessage(await login(request));
    return { errors };
  } catch (error) {
    const redirectUrl = getInstallRedirectUrl(error);
    if (redirectUrl) {
      return { errors: {}, redirectUrl };
    }
    throw error;
  }
};

const INSTALL_URL_RE = /(?:\\")?(https:\/\/admin\.shopify\.com\/store\/[^/]+\/oauth\/install\?[^"\\]+)/;

/** Parse install URL from actionData (object with redirectUrl or HTML string when server sent Response body). */
function getRedirectUrlFromData(data: unknown): string | undefined {
  if (!data) return undefined;
  if (typeof data === "object" && data !== null && "redirectUrl" in data) {
    const url = (data as { redirectUrl?: string }).redirectUrl;
    if (typeof url === "string") return url;
  }
  if (typeof data === "string") {
    const m = data.match(INSTALL_URL_RE);
    if (m) return m[1].replace(/\\"/g, "");
  }
  return undefined;
}

export default function Auth() {
  const loaderData = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const data = actionData ?? loaderData ?? {};
  const errors = (data as { errors?: { shop?: string } }).errors ?? {};
  const fromAction = getRedirectUrlFromData(actionData);
  const fromLoader = getRedirectUrlFromData(loaderData);
  const redirectUrl = fromAction ?? fromLoader;

  useEffect(() => {
    if (redirectUrl && window.top) {
      window.top.location.replace(redirectUrl);
    }
  }, [redirectUrl]);

  return (
    <AppProvider embedded={false}>
      <s-page>
        {redirectUrl ? (
          <s-section heading="Redirecting">
            <p>Redirecting to install…</p>
            <p>
              <a href={redirectUrl} target="_top" rel="noopener noreferrer">
                Click here if not redirected
              </a>
            </p>
          </s-section>
        ) : (
          <>
            <form action="/auth/login" method="post" target="_top">
              <s-section heading="Log in">
                <s-stack direction="block" gap="base">
                  <s-text-field
                    label="Shop domain"
                    name="shop"
                    placeholder="yourstore.myshopify.com"
                    autocomplete="on"
                    required
                  />
                  {errors?.shop && (
                    <s-banner tone="critical" dismissible={false}>
                      {errors.shop}
                    </s-banner>
                  )}
                  <s-button type="submit">Log in</s-button>
                </s-stack>
              </s-section>
            </form>
            <p className={styles.helpText}>
              If you were sent back here after installing, open the app from your Shopify Admin: <strong>Apps → revstack</strong>.
            </p>
          </>
        )}
      </s-page>
    </AppProvider>
  );
}
