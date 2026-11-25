# WA Campaign Scheduler

Excel se numbers + messages + images lo, aur WhatsApp par **dheere‑dheere, safe gaps ke saath** daily bhejo. Poora free.

**Dashboard (public URL):** https://gauravsri1020.github.io/wa-campaign-scheduler/

## Kaise kaam karta hai

| | A · WhatsApp Web + extension | B · Official Cloud API |
|---|---|---|
| Kharcha | ₹0 | GitHub free, lekin Meta har marketing message ka paisa leta hai (India ≈ ₹0.86) |
| Number | Aapka normal WhatsApp / WhatsApp Business app number | Naya number jo WhatsApp app par active na ho |
| Message | Kuch bhi likho, image + caption | Meta‑approved template (marketing ke liye zaroori) |
| Kahan chalta hai | Aapke Chrome me (laptop on + online hona chahiye) | GitHub Actions par, laptop band ho tab bhi |
| Ban risk | Hai (automation officially allowed nahi) — low volume rakho | Nahi (official) |

## Excel format

* Sheet **Contacts**: `Phone` (zaroori), `Name`, aur koi bhi column (`City`, …) → message me `{name}`, `{city}` likh sakte ho.
* Sheet **Messages**: `Message`, `Image` (image ki file name, jaise `offer.jpg`), `Date` (YYYY‑MM‑DD, sirf "By date" mode ke liye).
* Contacts sheet me hi `Message` column ho to har contact ko uska apna message jayega.
* Wording vary karne ke liye: `{Hi|Hello|Namaste} {name}!`
* Dashboard par “Download sample Excel” button se ready template milta hai.

## A · WhatsApp Web (free) – setup

1. Is repo ka ZIP download karo → unzip.
2. Chrome → `chrome://extensions` → **Developer mode** on → **Load unpacked** → `extension` folder choose karo.
3. Usi Chrome me https://web.whatsapp.com kholo, QR scan karo.
4. Dashboard kholo → pill green dikhega → Excel upload → images → schedule → **Send test** apne number par → **Load schedule & start**.

Extension har message ke liye WhatsApp Web me chat kholta hai, image attach karta hai, caption type karta hai aur Send dabata hai.
Daily cap, sending window aur random gap extension khud enforce karta hai; browser band raha to baad me continue karta hai (ek saath burst nahi karta).
Contacts aapke computer se bahar nahi jaate.

**Safe limits:** naya number → pehle hafte 10–15/day, phir 25–40/day; gap ≥ 8 min; har message me naam + “Reply STOP to unsubscribe”. Sirf unko bhejo jo aapko jaante hain.

## B · Cloud API (GitHub Actions) – setup

1. https://developers.facebook.com/apps → Create app (Business) → WhatsApp add karo.
2. API Setup me business number add + verify karo → **Phone number ID** copy.
3. Business Settings → System users → token generate (`whatsapp_business_messaging`, `whatsapp_business_management`) → **WA_TOKEN**.
4. WhatsApp Manager → Message templates → Marketing template banao (optional image header, body `Hi {{1}}…`) → approval ka wait.
5. Payment method add karo.
6. Repo → Settings → Secrets and variables → Actions → secrets: `WA_TOKEN`, `WA_PHONE_NUMBER_ID`, `CAMPAIGN_KEY` (koi bhi lambi passphrase).
7. Dashboard → tab B → GitHub token (fine‑grained, is repo par Contents + Actions read/write) + same passphrase → **Encrypt & push**.

Workflow `.github/workflows/send.yml` har 10 min chalta hai, `wa-data` branch se encrypted campaign padhta hai aur progress `state.json` me save karta hai.
Contacts browser me hi AES‑256 se encrypt hote hain, isliye public repo me sirf unreadable data hota hai.

> GitHub 60 din tak repo me activity na ho to scheduled workflows band kar deta hai — Actions tab me jaakar “Enable workflow” dabana.

## Files

```
index.html               dashboard (GitHub Pages)
extension/               Chrome extension (WhatsApp Web sender)
api-sender/send.mjs      Cloud API sender (Node 20, no dependencies)
.github/workflows/send.yml
```
