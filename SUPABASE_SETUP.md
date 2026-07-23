# Supabase einrichten

1. In deinem Supabase-Projekt links auf **SQL Editor** klicken.
2. **New query** wählen.
3. Den kompletten Inhalt von `supabase-schema.sql` hineinkopieren und **Run** klicken.
4. Danach links auf **Authentication → Providers → Email** gehen und die E-Mail-Anmeldung aktiv lassen.
5. Für die erste Testphase kannst du unter **Authentication → URL Configuration** bei `Site URL` `http://localhost` eintragen. Sobald die Website bei Cloudflare Pages veröffentlicht ist, ersetzen wir das durch deren Adresse.

Das Skript erstellt die Tabellen für Familien, Mitglieder, Termine, Aufgaben, Einladungen und Dateien. Außerdem setzt es Sicherheitsregeln: Nur Personen in derselben Familie können deren Inhalte sehen oder ändern.
