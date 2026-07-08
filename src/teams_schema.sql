-- teams_schema.sql
-- Lisää "asennusporukka" (tiimi, 2-4 henkeä) -käsitteen sekä valvomon
-- piilotus/poisto-ominaisuuden vaatimat sarakkeet. Aja tämä kokonaisuudessaan
-- Supabasen SQL Editorissa (Dashboard → SQL Editor → New query).

-- 1) Tiimit
create table if not exists teams (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  created_at timestamptz default now()
);

-- 2) Asentaja voi kuulua yhteen tiimiin (valinnainen — yksittäinen asentaja
--    ilman tiimiä toimii edelleen täysin normaalisti kuten ennenkin)
alter table installers add column if not exists team_id uuid references teams(id) on delete set null;

-- 3) Havainto voidaan osoittaa joko yksittäiselle asentajalle
--    (assigned_installer_id, kuten ennenkin) TAI kokonaiselle tiimille
--    (assigned_team_id) — jälkimmäisessä tapauksessa kaikki tiimin jäsenet
--    näkevät tehtävän ja saavat ilmoituksen.
alter table observations add column if not exists assigned_team_id uuid references teams(id) on delete set null;

-- 4) Valvomon "piilota" -toiminto: ei poista dataa, vain merkitsee sen pois
--    näkyvistä avoimet/korjatut-listoilta. NULL = ei piilotettu.
alter table observations add column if not exists hidden_at timestamptz;

-- 5) Oikeudet — sama malli kuin muillakin tauluilla (anon = sovelluksen oma
--    julkinen avain, service_role = Edge Functionit)
grant select, insert, update, delete on teams to anon, service_role;
grant select, insert, update on installers to anon, service_role;

-- HUOM: tämä myöntää anon-roolille myös DELETE observations-taulusta, jotta
-- valvomon "Poista pysyvästi" -nappi toimii. Tämä oli aiemmin tarkoituksella
-- pois päältä (esti asentajaa vahingossa tyhjentämästä pilvidataa), mutta
-- koska valvomo on nimenomaan työnjohtajan oma työkalu pysyvään poistoon,
-- oikeus avataan uudelleen. Jos tämä tuntuu liian riskialttiilta, voi jättää
-- rivin ajamatta — silloin "Poista pysyvästi" epäonnistuu siististi ja vain
-- "Piilota"-toiminto (hidden_at) on käytössä.
grant delete on observations to anon;
