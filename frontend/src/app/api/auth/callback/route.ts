import { NextRequest, NextResponse } from "next/server";

export async function GET(request: NextRequest) {
  const searchParams = request.nextUrl.searchParams;
  const code = searchParams.get("code");

  if (!code) {
    return NextResponse.redirect(new URL("/?error=no_code", request.url));
  }

  const clientId = process.env.SPOTIFY_CLIENT_ID;
  const clientSecret = process.env.SPOTIFY_SECRET;
  const redirectUri = "http://127.0.0.1:3000/api/auth/callback";

  try {
    const response = await fetch("https://accounts.spotify.com/api/token", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`,
      },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: code,
        redirect_uri: redirectUri,
      }),
    });

    const data = await response.json();

    if (data.access_token) {
      // Pass tokens via URL params so client can store them
      const params = new URLSearchParams({
        spotify: 'success',
        access_token: data.access_token,
        refresh_token: data.refresh_token || '',
        expires_in: data.expires_in.toString(),
      });
      
      return NextResponse.redirect(new URL(`/setup?${params.toString()}`, request.url));
    }

    return NextResponse.redirect(new URL(`/?error=${data.error || 'token_error'}`, request.url));
  } catch (error) {
    console.error("Error exchanging code for token:", error);
    return NextResponse.redirect(new URL("/?error=exchange_failed", request.url));
  }
}
