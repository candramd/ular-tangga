// Package engine contains deterministic game rules. Callers serialize access and
// supply the clock, dice, and identifiers; it has no network or storage dependency.
package engine

import (
	"errors"
	"fmt"
	"maps"
	"strconv"
	"time"
)

type User struct {
	ID        string `json:"id"`
	Username  string `json:"username"`
	XP        int    `json:"xp"`
	Coins     int    `json:"coins"`
	Level     int    `json:"level"`
	Synthetic bool   `json:"synthetic,omitempty"`
}

type Player struct {
	User
	Position    int  `json:"position"`
	IsConnected bool `json:"isConnected"`
}

type Room struct {
	ID       string   `json:"id"`
	Code     string   `json:"code"`
	HostID   string   `json:"hostId"`
	Status   string   `json:"status"`
	Mode     string   `json:"mode,omitempty"`
	IsPublic bool     `json:"isPublic"`
	Players  []Player `json:"players"`
	GameID   string   `json:"gameId,omitempty"`
}

// ModeLocal marks a pass-and-play room: every player acts from the host's
// single session by naming the acting player in each request.
const ModeLocal = "local"

type Question struct {
	ID         string   `json:"id"`
	Question   string   `json:"question"`
	Options    []string `json:"options"`
	Category   string   `json:"category"`
	Difficulty string   `json:"difficulty"`
	TimeLimit  int      `json:"timeLimit"`
}

type Game struct {
	ID              string         `json:"id"`
	RoomID          string         `json:"roomId"`
	Status          string         `json:"status"`
	TurnNumber      int            `json:"turnNumber"`
	CurrentPlayerID string         `json:"currentPlayerId"`
	TurnState       string         `json:"turnState"`
	Players         []Player       `json:"players"`
	Question        *Question      `json:"question,omitempty"`
	Deadline        time.Time      `json:"deadline"`
	DiceResult      int            `json:"diceResult"`
	WinnerID        string         `json:"winnerId,omitempty"`
	TotalSteps      int            `json:"totalSteps"`
	Snakes          map[string]int `json:"snakes"`
	Ladders         map[string]int `json:"ladders"`
}

type AnswerResult struct {
	PlayerID      string `json:"playerId"`
	Result        string `json:"result"`
	CorrectAnswer int    `json:"correctAnswer"`
	Explanation   string `json:"explanation"`
	Position      int    `json:"position"`
	XP            int    `json:"xp"`
	Coins         int    `json:"coins"`
	DiceUnlocked  bool   `json:"diceUnlocked"`
}

type Event struct {
	Event      string    `json:"event"`
	GameID     string    `json:"gameId,omitempty"`
	TurnNumber int       `json:"turnNumber,omitempty"`
	Timestamp  time.Time `json:"timestamp"`
	Payload    any       `json:"payload"`
}

// State is private server state, including the answer key. Only View is sent
// to clients; Bank never reaches them because Snapshot only returns View.
type State struct {
	View        Game                    `json:"view"`
	AnswerIndex int                     `json:"answerIndex"`
	Explanation string                  `json:"explanation"`
	Results     map[string]AnswerResult `json:"results"`
	// Bank is the immutable question snapshot this game draws from. It is
	// persisted with the game so the in-flight game survives restarts with the
	// same questions, even after admin edits or deletions.
	Bank *Bank `json:"bank,omitempty"`
}

type Board struct {
	TotalSteps int            `json:"totalSteps"`
	Snakes     map[string]int `json:"snakes"`
	Ladders    map[string]int `json:"ladders"`
}

func DefaultBoard(total int) Board {
	b := Board{TotalSteps: total, Snakes: map[string]int{}, Ladders: map[string]int{}}
	for from, to := range map[int]int{17: 7, 54: 34, 62: 19, 87: 24, 93: 73, 98: 79} {
		if from < total {
			b.Snakes[strconv.Itoa(from)] = to
		}
	}
	for from, to := range map[int]int{3: 22, 8: 30, 20: 41, 28: 55, 50: 69, 71: 92} {
		if to < total {
			b.Ladders[strconv.Itoa(from)] = to
		}
	}
	return b
}

func (b Board) Validate() error {
	if b.TotalSteps < 10 || b.TotalSteps > 1000 {
		return errors.New("totalSteps must be between 10 and 1000")
	}
	for name, jumps := range map[string]map[string]int{"snakes": b.Snakes, "ladders": b.Ladders} {
		for from, to := range jumps {
			n, err := strconv.Atoi(from)
			if err != nil || strconv.Itoa(n) != from || n < 1 || n >= b.TotalSteps || to < 1 || to > b.TotalSteps || n == to {
				return fmt.Errorf("invalid %s jump %s", name, from)
			}
			if name == "snakes" && to >= n || name == "ladders" && to <= n {
				return errors.New("jump direction is invalid")
			}
			if _, ok := b.Snakes[strconv.Itoa(to)]; ok {
				return errors.New("chained jumps are not supported")
			}
			if _, ok := b.Ladders[strconv.Itoa(to)]; ok {
				return errors.New("chained jumps are not supported")
			}
			if _, ok := b.Snakes[from]; ok && name == "ladders" {
				return errors.New("overlapping jumps")
			}
		}
	}
	return nil
}

var (
	ErrTurn       = errors.New("not your turn")
	ErrState      = errors.New("action is not available in the current turn state")
	ErrQuestion   = errors.New("question does not match the current turn")
	ErrDiceLocked = errors.New("dice is not unlocked")
)

func New(id, roomID string, players []Player, board Board, bank *Bank, now time.Time) (*State, error) {
	if err := board.Validate(); err != nil {
		return nil, err
	}
	if len(players) < 2 || len(players) > 4 {
		return nil, errors.New("a game requires 2 to 4 players")
	}
	seen := map[string]bool{}
	for _, p := range players {
		if p.ID == "" || seen[p.ID] {
			return nil, errors.New("players must have unique IDs")
		}
		seen[p.ID] = true
	}
	// Snapshot the bank at game start: admin edits and deletions never alter
	// questions already drawn or to be drawn by an in-flight game.
	if bank != nil {
		bank = NewBank(bank.Items)
	}
	s := &State{View: Game{ID: id, RoomID: roomID, Status: "playing", Players: append([]Player(nil), players...), TotalSteps: board.TotalSteps, Snakes: maps.Clone(board.Snakes), Ladders: maps.Clone(board.Ladders)}, Results: map[string]AnswerResult{}, Bank: bank}
	if s.View.Snakes == nil {
		s.View.Snakes = map[string]int{}
	}
	if s.View.Ladders == nil {
		s.View.Ladders = map[string]int{}
	}
	for i := range s.View.Players {
		s.View.Players[i].Position = 0
	}
	s.next(0, now)
	return s, nil
}

// AttachBank replaces the game's bank snapshot. Only callers restoring legacy
// persisted state that predates the bank field need this; normally the bank is
// captured in New and persisted with the game.
func (s *State) AttachBank(b *Bank) {
	s.Bank = b
}

func (s *State) Snapshot() Game {
	g := s.View
	g.Players = append([]Player(nil), g.Players...)
	g.Snakes, g.Ladders = maps.Clone(g.Snakes), maps.Clone(g.Ladders)
	if g.Question != nil {
		q := *g.Question
		q.Options = append([]string(nil), q.Options...)
		g.Question = &q
	}
	return g
}

func (s *State) event(name string, payload any, now time.Time) Event {
	return Event{Event: name, GameID: s.View.ID, TurnNumber: s.View.TurnNumber, Timestamp: now.UTC(), Payload: payload}
}

func (s *State) StateEvent(now time.Time) Event { return s.event("game:state", s.Snapshot(), now) }

func (s *State) turnEvent(now time.Time) Event {
	return s.event("turn:changed", map[string]any{"turnNumber": s.View.TurnNumber, "playerId": s.View.CurrentPlayerID}, now)
}

func (s *State) index(id string) int {
	for i, p := range s.View.Players {
		if p.ID == id {
			return i
		}
	}
	return -1
}

func (s *State) next(index int, now time.Time) {
	s.View.TurnNumber++
	s.View.CurrentPlayerID = s.View.Players[index%len(s.View.Players)].ID
	s.View.TurnState = "QUESTION"
	q, answer, explanation := s.Bank.draw(s.View.TurnNumber)
	q.ID = fmt.Sprintf("%s-q%d", s.View.ID, s.View.TurnNumber)
	s.View.Question = &q
	s.AnswerIndex, s.Explanation = answer, explanation
	tl := q.TimeLimit
	if tl <= 0 {
		tl = 30
	}
	s.View.Deadline = now.UTC().Add(time.Duration(tl) * time.Second)
}

func (s *State) Answer(actor, questionID string, answer int, now time.Time) (AnswerResult, []Event, error) {
	if old, ok := s.Results[questionID]; ok {
		if old.PlayerID != actor {
			return AnswerResult{}, nil, ErrTurn
		}
		return old, nil, nil
	}
	if s.View.Status != "playing" || s.View.TurnState != "QUESTION" {
		return AnswerResult{}, nil, ErrState
	}
	if actor != s.View.CurrentPlayerID {
		return AnswerResult{}, nil, ErrTurn
	}
	if s.View.Question.ID != questionID {
		return AnswerResult{}, nil, ErrQuestion
	}
	if answer < 0 || answer >= len(s.View.Question.Options) {
		return AnswerResult{}, nil, errors.New("answer must be a zero-based option index")
	}
	result := "wrong"
	if !now.Before(s.View.Deadline) {
		result = "timeout"
	} else if answer == s.AnswerIndex {
		result = "correct"
	}
	r, events := s.resolve(result, now)
	return r, events, nil
}

func (s *State) resolve(result string, now time.Time) (AnswerResult, []Event) {
	i := s.index(s.View.CurrentPlayerID)
	p := &s.View.Players[i]
	if result == "correct" {
		p.XP += 10
		p.Coins += 5
		p.Level = 1 + p.XP/100
		s.View.TurnState = "DICE_UNLOCKED"
	}
	r := AnswerResult{PlayerID: p.ID, Result: result, CorrectAnswer: s.AnswerIndex, Explanation: s.Explanation, Position: p.Position, XP: p.XP, Coins: p.Coins, DiceUnlocked: result == "correct"}
	s.Results[s.View.Question.ID] = r
	events := []Event{s.event("question:result", r, now)}
	if result != "correct" {
		s.next(i+1, now)
		events = append(events, s.turnEvent(now))
	}
	events = append(events, s.StateEvent(now))
	return r, events
}

func (s *State) Expire(now time.Time) []Event {
	if s.View.Status != "playing" || s.View.TurnState != "QUESTION" || now.Before(s.View.Deadline) {
		return nil
	}
	_, events := s.resolve("timeout", now)
	return events
}

func (s *State) Roll(actor string, dice int, now time.Time) ([]Event, error) {
	if s.View.Status != "playing" || s.View.TurnState != "DICE_UNLOCKED" {
		return nil, ErrDiceLocked
	}
	if actor != s.View.CurrentPlayerID {
		return nil, ErrTurn
	}
	if dice < 1 || dice > 6 {
		return nil, errors.New("invalid dice")
	}
	s.View.DiceResult = dice
	s.View.TurnState = "MOVING"
	events := []Event{s.event("dice:rolled", struct {
		PlayerID string `json:"playerId"`
		Value    int    `json:"value"`
	}{actor, dice}, now), s.StateEvent(now)}
	events = append(events, s.event("player:move_started", map[string]any{"playerId": actor}, now))
	i := s.index(actor)
	p := &s.View.Players[i]
	step := func(position int) {
		p.Position = position
		events = append(events, s.event("player:step", struct {
			PlayerID string `json:"playerId"`
			Position int    `json:"position"`
		}{actor, position}, now))
	}
	if target := p.Position + dice; target <= s.View.TotalSteps {
		for p.Position < target {
			step(p.Position + 1)
		}
		if dest, ok := s.View.Snakes[strconv.Itoa(p.Position)]; ok {
			events = append(events, s.event("snake:triggered", map[string]any{"playerId": actor, "from": p.Position, "to": dest}, now))
			step(dest)
		} else if dest, ok := s.View.Ladders[strconv.Itoa(p.Position)]; ok {
			events = append(events, s.event("ladder:triggered", map[string]any{"playerId": actor, "from": p.Position, "to": dest}, now))
			step(dest)
		}
	}
	events = append(events, s.event("player:moved", map[string]any{"playerId": actor, "position": p.Position}, now))
	if p.Position == s.View.TotalSteps {
		s.finish(actor)
	} else {
		s.next(i+1, now)
		events = append(events, s.turnEvent(now))
	}
	events = append(events, s.StateEvent(now))
	return events, nil
}

func (s *State) finish(winner string) {
	s.View.Status, s.View.TurnState, s.View.WinnerID = "finished", "FINISHED", winner
	s.View.Question = nil
}

func (s *State) Leave(actor string, now time.Time) []Event {
	i := s.index(actor)
	if i < 0 {
		return nil
	}
	current := s.View.CurrentPlayerID == actor
	s.View.Players = append(s.View.Players[:i], s.View.Players[i+1:]...)
	if s.View.Status == "playing" {
		if len(s.View.Players) <= 1 {
			winner := ""
			if len(s.View.Players) == 1 {
				winner = s.View.Players[0].ID
			}
			s.finish(winner)
		} else if current {
			s.next(i, now)
		}
	}
	return []Event{s.StateEvent(now)}
}
