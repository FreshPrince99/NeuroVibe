import { NextResponse } from "next/server";
import { cookies } from "next/headers";

export async function GET() {
  const cookieStore = await cookies();
  const accessToken = cookieStore.get("spotify_access_token")?.value;
  const refreshToken = cookieStore.get("spotify_refresh_token")?.value;

  console.log("Token endpoint - Access token exists:", !!accessToken);
  console.log("Token endpoint - Refresh token exists:", !!refreshToken);

  if (!accessToken && refreshToken) {
    // Try to refresh the token
    try {
      const clientId = process.env.SPOTIFY_CLIENT_ID;
      const clientSecret = process.env.SPOTIFY_SECRET;

      const response = await fetch("https://accounts.spotify.com/api/token", {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`,
        },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: refreshToken,
        }),
      });

      const data = await response.json();

      if (data.access_token) {
        cookieStore.set("spotify_access_token", data.access_token, {
          httpOnly: true,
          secure: process.env.NODE_ENV === "production",
          maxAge: data.expires_in,
          path: "/",
        });

        return NextResponse.json({ access_token: data.access_token });
      }
    } catch (error) {
      console.error("Error refreshing token:", error);
      return NextResponse.json({ error: "Failed to refresh token" }, { status: 401 });
    }
  }

  if (accessToken) {
    console.log("Token endpoint - Returning access token");
    return NextResponse.json({ access_token: accessToken });
  }

  console.log("Token endpoint - No token available");
  return NextResponse.json({ error: "No access token available" }, { status: 401 });
}
