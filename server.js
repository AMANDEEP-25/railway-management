const express = require("express");
const { Pool } = require("pg");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const dotenv = require("dotenv");

dotenv.config();
const app = express();
app.use(express.json());

const pool = new Pool({
  user: process.env.DB_USER,
  host: process.env.DB_HOST,
  database: process.env.DB_NAME,
  password: process.env.DB_PASSWORD,
  port: 5432,
});

// Middlewares
const checkAdminApiKey = (req, res, next) => {
  const apiKey = req.headers["x-api-key"];
  if (apiKey === process.env.ADMIN_API_KEY) next();
  else res.status(401).json({ message: "Unauthorized" });
};

const auth = (req, res, next) => {
  const token = req.headers.authorization?.split(" ")[1];
  if (!token) return res.status(401).json({ message: "No token provided" });
  jwt.verify(token, process.env.JWT_SECRET, (err, decoded) => {
    if (err) return res.status(401).json({ message: "Invalid token" });
    req.user = decoded;
    next();
  });
};

// Routes
app.post("/api/auth/register", async (req, res) => {
  const { name, email, password, role } = req.body;
  const hashedPassword = await bcrypt.hash(password, 10);
  try {
    const result = await pool.query(
      "INSERT INTO users (name, email, password, role) VALUES ($1, $2, $3, $4) RETURNING id, name, email, role",
      [name, email, hashedPassword, role || "user"]
    );
    res.status(201).json({ user: result.rows[0] });
  } catch (error) {
    if (error.code === "23505")
      res.status(400).json({ message: "Email exists" });
    else res.status(500).json({ message: "Server error" });
  }
});

app.post("/api/auth/login", async (req, res) => {
  const { email, password } = req.body;
  try {
    const result = await pool.query("SELECT * FROM users WHERE email = $1", [
      email,
    ]);
    if (!result.rows[0])
      return res.status(400).json({ message: "Invalid credentials" });
    const user = result.rows[0];
    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch)
      return res.status(400).json({ message: "Invalid credentials" });
    const token = jwt.sign(
      { id: user.id, role: user.role },
      process.env.JWT_SECRET,
      { expiresIn: "1h" }
    );
    res.json({ token });
  } catch (error) {
    res.status(500).json({ message: "Server error" });
  }
});
// Get all trains (any route)
app.get("/api/trains", async (req, res) => {
  try {
    const result = await pool.query("SELECT * FROM trains");
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ message: "Server error" });
  }
});

app.post("/api/trains", checkAdminApiKey, async (req, res) => {
  const { name, source, destination, total_seats } = req.body;
  try {
    const result = await pool.query(
      "INSERT INTO trains (name, source, destination, total_seats, available_seats) VALUES ($1, $2, $3, $4, $5) RETURNING *",
      [name, source, destination, total_seats, total_seats]
    );
    res.status(201).json(result.rows[0]);
  } catch (error) {
    res.status(500).json({ message: "Server error" });
  }
});

app.get("/api/trains/availability", async (req, res) => {
  const { source, destination } = req.query;
  try {
    const result = await pool.query(
      "SELECT * FROM trains WHERE source = $1 AND destination = $2 AND available_seats > 0",
      [source, destination]
    );
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ message: "Server error" });
  }
});

app.post("/api/bookings", auth, async (req, res) => {
  const { train_id } = req.body;
  const user_id = req.user.id;
  try {
    await pool.query("BEGIN");
    const trainResult = await pool.query(
      "SELECT * FROM trains WHERE id = $1 FOR UPDATE",
      [train_id]
    );
    if (!trainResult.rows[0]) {
      await pool.query("ROLLBACK");
      return res.status(404).json({ message: "Train not found" });
    }
    const train = trainResult.rows[0];
    if (train.available_seats <= 0) {
      await pool.query("ROLLBACK");
      return res.status(400).json({ message: "No seats available" });
    }
    await pool.query(
      "UPDATE trains SET available_seats = available_seats - 1 WHERE id = $1",
      [train_id]
    );
    const bookingResult = await pool.query(
      "INSERT INTO bookings (user_id, train_id) VALUES ($1, $2) RETURNING *",
      [user_id, train_id]
    );
    await pool.query("COMMIT");
    res.status(201).json(bookingResult.rows[0]);
  } catch (error) {
    await pool.query("ROLLBACK");
    res.status(500).json({ message: "Server error" });
  }
});

app.get("/api/bookings/:bookingId", auth, async (req, res) => {
  const { bookingId } = req.params;
  try {
    const result = await pool.query(
      "SELECT * FROM bookings WHERE id = $1 AND user_id = $2",
      [bookingId, req.user.id]
    );
    if (!result.rows[0])
      return res.status(404).json({ message: "Booking not found" });
    res.json(result.rows[0]);
  } catch (error) {
    res.status(500).json({ message: "Server error" });
  }
});

app.put("/api/trains/:trainId", checkAdminApiKey, async (req, res) => {
  const { trainId } = req.params;
  const { total_seats } = req.body;
  try {
    const result = await pool.query(
      "UPDATE trains SET total_seats = $1, available_seats = available_seats + ($1 - total_seats) WHERE id = $2 RETURNING *",
      [total_seats, trainId]
    );
    if (!result.rows[0])
      return res.status(404).json({ message: "Train not found" });
    res.json(result.rows[0]);
  } catch (error) {
    res.status(500).json({ message: "Server error" });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
