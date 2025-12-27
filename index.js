require("dotenv").config();
const express = require("express");
const axios = require("axios");
const path = require("path");
const { Pool } = require("pg");

const app = express();

app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));

app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, "public")));

const pool = new Pool({
  host: process.env.PGHOST,
  port: Number(process.env.PGPORT),
  database: process.env.PGDATABASE,
  user: process.env.PGUSER,
  password: process.env.PGPASSWORD,
});


// Small helper: cover URL (no axios needed for image)
function coverUrlFromIsbn(isbn, size = "M") {
  if (!isbn) return null;
  // Open Library Covers:
  // https://openlibrary.org/dev/docs/api/covers
  return `https://covers.openlibrary.org/b/isbn/${encodeURIComponent(isbn)}-${size}.jpg`;
}

// Home (list + sorting)
app.get("/", async (req, res) => {
  const sort = (req.query.sort || "recency").toLowerCase();

  const sortSql = {
    recency: "date_read DESC, created_at DESC",
    rating: "rating DESC, date_read DESC",
    title: "LOWER(title) ASC",
  }[sort] || "date_read DESC, created_at DESC";

  try {
    const { rows } = await pool.query(
      `SELECT id, title, author, isbn, rating, notes, date_read
       FROM books
       ORDER BY ${sortSql}`
    );

    const books = rows.map((b) => ({
      ...b,
      coverUrl: coverUrlFromIsbn(b.isbn),
    }));

    res.render("index", { books, sort });
  } catch (err) {
    console.error(err);
    res.status(500).render("error", {
      message: "Could not load books from the database.",
      details: err.message,
    });
  }
});

// New book form (also supports Open Library search)
app.get("/books/new", (req, res) => {
  res.render("new", { results: [], q: "", error: null });
});

// Search Open Library to prefill book fields
app.get("/api/search", async (req, res) => {
  const q = (req.query.q || "").trim();
  if (!q) return res.status(400).json({ error: "Missing query param q" });

  try {
    // Open Library Search API (no key)
    const url = "https://openlibrary.org/search.json";
    const { data } = await axios.get(url, {
      params: { q, limit: 10 },
      timeout: 8000,
    });

    // Normalize results
    const docs = (data.docs || []).map((d) => ({
      title: d.title || "",
      author: Array.isArray(d.author_name) ? d.author_name[0] : "",
      isbn: Array.isArray(d.isbn) ? d.isbn[0] : "",
      first_publish_year: d.first_publish_year || null,
      key: d.key || null,
    }));

    res.json({ results: docs });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Open Library search failed", details: err.message });
  }
});

// Create book
app.post("/books", async (req, res) => {
  const { title, author, isbn, rating, notes, date_read } = req.body;

  // Minimal validation
  const cleanTitle = (title || "").trim();
  const cleanAuthor = (author || "").trim();

  if (!cleanTitle || !cleanAuthor) {
    return res.status(400).render("error", {
      message: "Title and author are required.",
      details: "Please go back and fill in the missing fields.",
    });
  }

  const ratingInt = Number(rating);
  const safeRating = Number.isInteger(ratingInt) ? Math.min(5, Math.max(1, ratingInt)) : 3;

  try {
    await pool.query(
      `INSERT INTO books (title, author, isbn, rating, notes, date_read)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        cleanTitle,
        cleanAuthor,
        (isbn || "").trim() || null,
        safeRating,
        (notes || "").trim(),
        date_read || new Date().toISOString().slice(0, 10),
      ]
    );

    res.redirect("/");
  } catch (err) {
    console.error(err);
    res.status(500).render("error", {
      message: "Could not save the book to the database.",
      details: err.message,
    });
  }
});

// Single book page
app.get("/books/:id", async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).render("error", { message: "Invalid book id.", details: "" });

  try {
    const { rows } = await pool.query(
      `SELECT id, title, author, isbn, rating, notes, date_read
       FROM books
       WHERE id = $1`,
      [id]
    );

    if (rows.length === 0) {
      return res.status(404).render("error", { message: "Book not found.", details: "" });
    }

    const book = { ...rows[0], coverUrl: coverUrlFromIsbn(rows[0].isbn, "L") };
    res.render("book", { book });
  } catch (err) {
    console.error(err);
    res.status(500).render("error", { message: "Could not load book.", details: err.message });
  }
});

// Edit form
app.get("/books/:id/edit", async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).render("error", { message: "Invalid book id.", details: "" });

  try {
    const { rows } = await pool.query(
      `SELECT id, title, author, isbn, rating, notes, date_read
       FROM books
       WHERE id = $1`,
      [id]
    );

    if (rows.length === 0) {
      return res.status(404).render("error", { message: "Book not found.", details: "" });
    }

    res.render("edit", { book: rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).render("error", { message: "Could not load edit form.", details: err.message });
  }
});

// Update book
app.post("/books/:id", async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).render("error", { message: "Invalid book id.", details: "" });

  const { title, author, isbn, rating, notes, date_read } = req.body;

  const cleanTitle = (title || "").trim();
  const cleanAuthor = (author || "").trim();
  if (!cleanTitle || !cleanAuthor) {
    return res.status(400).render("error", { message: "Title and author are required.", details: "" });
  }

  const ratingInt = Number(rating);
  const safeRating = Number.isInteger(ratingInt) ? Math.min(5, Math.max(1, ratingInt)) : 3;

  try {
    const result = await pool.query(
      `UPDATE books
       SET title=$1, author=$2, isbn=$3, rating=$4, notes=$5, date_read=$6
       WHERE id=$7`,
      [
        cleanTitle,
        cleanAuthor,
        (isbn || "").trim() || null,
        safeRating,
        (notes || "").trim(),
        date_read || new Date().toISOString().slice(0, 10),
        id,
      ]
    );

    if (result.rowCount === 0) {
      return res.status(404).render("error", { message: "Book not found.", details: "" });
    }

    res.redirect(`/books/${id}`);
  } catch (err) {
    console.error(err);
    res.status(500).render("error", { message: "Could not update the book.", details: err.message });
  }
});

// Delete book
app.post("/books/:id/delete", async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).render("error", { message: "Invalid book id.", details: "" });

  try {
    await pool.query("DELETE FROM books WHERE id = $1", [id]);
    res.redirect("/");
  } catch (err) {
    console.error(err);
    res.status(500).render("error", { message: "Could not delete the book.", details: err.message });
  }
});

app.use((req, res) => {
  res.status(404).render("error", { message: "Page not found.", details: "" });
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`Server running on http://localhost:${port}`);
});
