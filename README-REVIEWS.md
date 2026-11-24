# EchElon Stones: Reviews setup

## What this adds

- **A Reviews section on the Home page.** It shows the average rating, a breakdown by stars, a "Verified purchases" filter and a "Write a review" button.
- **Ratings on each product page.** Each piece shows its score, a short quote and a link to its reviews.
- **Two kinds of reviewers.** Anyone can post. Buyers get a gold **Verified Purchase** label.
- **A private admin page** at `/admin-reviews.html`. You approve, hide or delete reviews, and manage orders.

## The one big change: how the site goes live

**Dragging the zip onto Netlify can't run server code.** Reviews need a server to save them, check orders and block spam. So the site now deploys from GitHub. After a one-time setup, every change you save in GitHub goes live by itself.

Everything still runs on Netlify. There are no new paid services.

## Setup (about 20 minutes, one time)

1. **Put the files on GitHub.**
   - Create a free account at github.com.
   - Make a new **private** repository called `elvinmade-site`.
   - Click **uploading an existing file**.
   - Drag in everything from this zip: the `site` folder, the `netlify` folder, `netlify.toml`, `package.json` and `package-lock.json`. Then click **Commit**.
2. **Connect Netlify to GitHub.**
   - In Netlify, open the elvinmade.com site.
   - Go to **Site configuration → Build & deploy → Continuous deployment → Link repository**.
   - Pick the GitHub repository. Leave every build setting blank, because `netlify.toml` already holds them.
3. **Get the free spam check from Cloudflare.**
   - At dash.cloudflare.com, open **Turnstile → Add widget**.
   - Hostname: `elvinmade.com`. Widget mode: **Managed**.
   - Copy the **Site Key** and the **Secret Key**.
4. **Add the settings in Netlify.** Go to **Site configuration → Environment variables** and add:

   | Name | What to put |
   |---|---|
   | `ADMIN_PASSWORD` | A long password, at least 12 characters. This is how you sign in to the admin page. |
   | `REVIEW_LINK_SECRET` | Any long random text, 32 or more characters. It signs the personal review links. Never share it. |
   | `TURNSTILE_SITE_KEY` | The Cloudflare Site Key |
   | `TURNSTILE_SECRET_KEY` | The Cloudflare Secret Key |
   | `SITE_URL` | `https://elvinmade.com` |
   | `AUTO_PUBLISH_VERIFIED` | *Optional.* Set to `false` if verified reviews should also wait for your approval. |

5. **Deploy.** Go to **Deploys → Trigger deploy**. When it finishes, open the Functions list under **Logs & metrics**. You should see `reviews`, `orders`, `order-link` and `admin`.
6. **Test it.**
   - Go to `elvinmade.com/admin-reviews.html` and sign in.
   - Post a test review on the site. It shows up under **Waiting**.
   - Approve it, then delete it.

## How Elvin uses it day to day

- **New review email arrives.** Open the admin page. Click **Approve** to make it public, or **Hide** to keep it off the site.
- **Order request arrives.** The email subject now includes a real order number, like `ES-482913`. When the deposit is in, open **Orders** and click **Deposit received**.
- **After the piece ships.** Open the order, click **Copy review link** and paste it into your follow-up email. When the customer opens the link, the review form fills in their order for them, and their review gets the Verified Purchase label.
- **Customers from before this feature.** Click **Add a past order**, then send them a review link.

## How "Verified Purchase" works, and the tradeoff

There's no payment processor yet, so the site can't see payments. A review is verified only when it matches an order **you marked as confirmed** (deposit received). The customer proves it's their order in one of two ways:

- They use the personal link you sent (the easiest way), or
- They enter their order number **and** the email they ordered with.

Each piece in an order can be reviewed once. If you delete that review, the customer can post again. When you add Stripe later, the "Deposit received" step can happen automatically instead.

## Spam protection

- **Cloudflare Turnstile:** an invisible human check.
- **A hidden trap field and a speed check:** bots fill forms instantly. They get a fake "thanks" and nothing is saved.
- **Limits:** 3 visitor reviews per hour and 8 per day from the same connection, and 10 order lookups per hour.
- **Content check:** reviews with links, code, spam words or ALL CAPS always wait for approval, even verified ones.
- **Admin lockout:** 8 wrong passwords locks that connection out for 15 minutes.
- **Default rule:** visitor reviews always wait for your approval. Verified reviews go live right away unless something gets flagged.

## Data (Netlify Blobs, no separate database)

| Store | Key | Holds |
|---|---|---|
| `es-reviews` | `r/<id>` | One review: rating, title, text, name, email (private), piece, verified, order number, status (`pending` / `approved` / `hidden`), flags, dates |
| `es-orders` | `o/ES-123456` | One order: name, email, pieces, status (`requested` / `confirmed`), dates |
| `es-orders` | `c/ES-123456/<piece>` | Marks that a piece in that order has been reviewed |
| `es-meta` | `index/public` | The cached public list (rebuilt from `es-reviews` on every change) |
| `es-limits` | `rl/...` | Rate-limit counters. Visitor addresses are stored only as scrambled codes. |

Visitors never see emails, order numbers or addresses. The public list only holds the name, rating, text, piece and date.

## Cost note

Netlify's free plan has a monthly credit limit, and every production deploy uses some of it. To stay well inside it, save several changes and push them together, not one at a time. Reviews traffic itself uses very little.

## File map

```
netlify.toml                      Netlify settings (publish folder, functions, admin headers)
package.json / package-lock.json  One dependency: @netlify/blobs
site/index.html                   The site + reviews section, product-page summary, review form, checkout hook
site/customize.html               Unchanged
site/admin-reviews.html           Private admin page (approve / hide / delete, orders, review links)
site/images/                      Unchanged
netlify/lib/core.mjs              Shared: storage, cleaning, spam checks, rate limits, Turnstile, signed links
netlify/functions/reviews.mjs     GET public reviews / POST a review        -> /api/reviews
netlify/functions/orders.mjs      POST from checkout, returns the order ref -> /api/orders
netlify/functions/order-link.mjs  Checks a personal review link            -> /api/order-link
netlify/functions/admin.mjs       Password-protected admin actions          -> /api/admin
tests/backend.test.mjs            Run with `npm test`
```

## What changed in index.html

Everything else in the file is untouched.

- **Styles:** added at the end of the stylesheet, all prefixed `rv-`.
- **Reviews section:** added on Home, after Bestsellers.
- **Product popup:** one line added under the description (`#pmRv`).
- **Checkout (`placeOrder`):** it now gets a real order number before the email is sent. The number goes in the subject and message, and the thank-you screen shows the same number. If the server can't be reached, checkout still works and the email says to add the order by hand.
- **Footer:** a "Reviews" link under Help.
- **Script:** the reviews code is at the end of the script, starting at `// ---------- Reviews ----------`.
