import { google } from "googleapis";

export function getOAuthClient({ clientId, clientSecret, refreshToken }) {
  const client = new google.auth.OAuth2(clientId, clientSecret);
  client.setCredentials({ refresh_token: refreshToken });
  return client;
}
