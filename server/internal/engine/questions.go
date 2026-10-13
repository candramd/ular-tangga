package engine

import (
	"fmt"
	"sort"
	"time"
)

// BankQuestion is the admin-managed question bank entry. It carries the answer
// key and must never be marshaled into any client-facing payload; the public
// DTO is Question, which has no answer fields.
type BankQuestion struct {
	ID          string    `json:"id"`
	Question    string    `json:"question"`
	Options     []string  `json:"options"`
	Answer      int       `json:"answer"`
	Explanation string    `json:"explanation,omitempty"`
	Category    string    `json:"category,omitempty"`
	Difficulty  string    `json:"difficulty,omitempty"`
	TimeLimit   int       `json:"timeLimit,omitempty"`
	Active      bool      `json:"active"`
	UpdatedAt   time.Time `json:"updatedAt"`
}

// Bank is a per-game immutable snapshot of the active custom questions. It is
// persisted inside State so an in-flight game keeps drawing from the exact bank
// it started with, across admin edits and server restarts.
type Bank struct {
	Items []BankQuestion `json:"items,omitempty"`
}

// NewBank filters to active questions, deep-copies options, and sorts by ID so
// draw order is deterministic. A nil/empty bank falls back to builtin questions.
func NewBank(questions []BankQuestion) *Bank {
	active := make([]BankQuestion, 0, len(questions))
	for _, q := range questions {
		if !q.Active {
			continue
		}
		opts := make([]string, len(q.Options))
		copy(opts, q.Options)
		active = append(active, BankQuestion{
			ID:          q.ID,
			Question:    q.Question,
			Options:     opts,
			Answer:      q.Answer,
			Explanation: q.Explanation,
			Category:    q.Category,
			Difficulty:  q.Difficulty,
			TimeLimit:   q.TimeLimit,
			Active:      q.Active,
			UpdatedAt:   q.UpdatedAt,
		})
	}
	sort.Slice(active, func(i, j int) bool { return active[i].ID < active[j].ID })
	return &Bank{Items: active}
}

func (b *Bank) Empty() bool {
	return b == nil || len(b.Items) == 0
}

func (b *Bank) draw(turn int) (Question, int, string) {
	if b.Empty() {
		return builtinQuestion(turn)
	}
	item := b.Items[(turn-1)%len(b.Items)]
	diff := item.Difficulty
	if diff == "" {
		diff = "mudah"
	}
	cat := item.Category
	if cat == "" {
		cat = "Umum"
	}
	tl := item.TimeLimit
	if tl <= 0 {
		tl = 30
	}
	return Question{
		Question:   item.Question,
		Options:    append([]string(nil), item.Options...),
		Category:   cat,
		Difficulty: diff,
		TimeLimit:  tl,
	}, item.Answer, item.Explanation
}

// builtinQuestion is the original hardcoded bank. It remains the fallback when
// a game has no active custom questions.
func builtinQuestion(turn int) (Question, int, string) {
	type item struct {
		text        string
		options     []string
		category    string
		answer      int
		explanation string
	}
	bank := []item{
		{"Planet terdekat dengan Matahari adalah ...", []string{"Venus", "Merkurius", "Bumi", "Mars"}, "Sains", 1, "Merkurius merupakan planet yang paling dekat dengan Matahari."},
		{"Proses tumbuhan membuat makanan dengan bantuan cahaya disebut ...", []string{"Respirasi", "Evaporasi", "Fotosintesis", "Fermentasi"}, "Sains", 2, "Fotosintesis mengubah air dan karbon dioksida menjadi makanan menggunakan energi cahaya."},
		{"Sila pertama Pancasila berbunyi ...", []string{"Ketuhanan Yang Maha Esa", "Persatuan Indonesia", "Keadilan sosial", "Kemanusiaan yang adil dan beradab"}, "Kewarganegaraan", 0, "Ketuhanan Yang Maha Esa adalah sila pertama Pancasila."},
		{"Antonim kata 'besar' adalah ...", []string{"Luas", "Tinggi", "Panjang", "Kecil"}, "Bahasa Indonesia", 3, "Antonim adalah kata yang berlawanan makna. Lawan kata besar adalah kecil."},
		{"Satu jam sama dengan berapa menit?", []string{"30", "60", "90", "100"}, "Matematika", 1, "Satu jam terdiri dari 60 menit."},
		{"Hewan pemakan tumbuhan disebut ...", []string{"Karnivora", "Omnivora", "Herbivora", "Insektivora"}, "Sains", 2, "Herbivora adalah hewan yang memakan tumbuhan."},
		{"Indonesia memproklamasikan kemerdekaan pada tanggal ...", []string{"17 Agustus 1945", "1 Juni 1945", "28 Oktober 1928", "10 November 1945"}, "Sejarah", 0, "Proklamasi Kemerdekaan Indonesia dibacakan pada 17 Agustus 1945."},
		{"Benda yang dapat menghantarkan listrik dengan baik adalah ...", []string{"Karet", "Kayu", "Plastik", "Tembaga"}, "Sains", 3, "Tembaga adalah logam konduktor yang sering digunakan sebagai kabel listrik."},
	}
	if turn%3 == 0 {
		a, b := 2+(turn*7)%23, 2+(turn*11)%19
		answer := turn % 4
		options := []string{fmt.Sprint(a + b + 2), fmt.Sprint(a + b - 1), fmt.Sprint(a + b + 1), fmt.Sprint(a + b - 2)}
		options[answer] = fmt.Sprint(a + b)
		return Question{Question: fmt.Sprintf("Berapakah hasil %d + %d?", a, b), Options: options, Category: "Matematika", Difficulty: "mudah", TimeLimit: 30}, answer, fmt.Sprintf("%d + %d = %d.", a, b, a+b)
	}
	i := bank[(turn-1)%len(bank)]
	return Question{Question: i.text, Options: append([]string(nil), i.options...), Category: i.category, Difficulty: "mudah", TimeLimit: 30}, i.answer, i.explanation
}