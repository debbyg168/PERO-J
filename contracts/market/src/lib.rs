#![no_std]
use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype, symbol_short, Address, Env, Symbol, Vec,
    panic_with_error,
};

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum Error {
    NotInitialized     = 1,
    AlreadyInitialized = 2,
    InvalidAmount      = 3,
    BetCountExceeded   = 4,
    BetAmountExceeded  = 5,
    ExposureExceeded   = 6,
    NotCouncilMember   = 7,
    AlreadyVoted       = 8,
    InvalidConfig      = 9,
}

/// Risk limits, configurable by the protocol admin. A value of 0 disables that limit.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Limits {
    /// Max bets one address may place across all markets.
    pub max_bets_per_user: u32,
    /// Max single bet amount (global default).
    pub max_bet_amount: i128,
    /// Max total stake one address may have across all markets.
    pub max_exposure_per_user: i128,
    /// Platform fee in basis points, taken from the gross amount.
    pub fee_bps: u32,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Council {
    pub members: Vec<Address>,
    pub threshold: u32,
    /// Seconds between the threshold being reached and the timelock deadline.
    pub timelock_secs: u64,
}

#[contracttype]
pub enum DataKey {
    Admin,
    Limits,
    Council,
    MarketMaxBet(u64),
    UserBets(Address),
    UserExposure(Address),
    MarketTotals(u64), // (total_yes, total_no, bet_count)
    Vote(u64, Address),
    Tally(u64, u32),
    Resolved(u64),
}

#[contract]
pub struct Market;

fn require_admin(env: &Env) {
    let a: Address = env
        .storage()
        .instance()
        .get(&DataKey::Admin)
        .unwrap_or_else(|| panic_with_error!(env, Error::NotInitialized));
    a.require_auth();
}

fn limits(env: &Env) -> Limits {
    env.storage()
        .instance()
        .get(&DataKey::Limits)
        .unwrap_or_else(|| panic_with_error!(env, Error::NotInitialized))
}

#[contractimpl]
impl Market {
    pub fn initialize(env: Env, admin: Address, limits: Limits) {
        if env.storage().instance().has(&DataKey::Admin) {
            panic_with_error!(&env, Error::AlreadyInitialized);
        }
        if limits.fee_bps > 10_000 {
            panic_with_error!(&env, Error::InvalidConfig);
        }
        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage().instance().set(&DataKey::Limits, &limits);
    }

    // ── Governance ───────────────────────────────────────────────────────────

    pub fn set_limits(env: Env, limits: Limits) {
        require_admin(&env);
        if limits.fee_bps > 10_000 {
            panic_with_error!(&env, Error::InvalidConfig);
        }
        env.storage().instance().set(&DataKey::Limits, &limits);
    }

    /// Per-market max bet amount; 0 clears the override and falls back to the global value.
    pub fn set_market_max_bet(env: Env, market_id: u64, max_bet_amount: i128) {
        require_admin(&env);
        if max_bet_amount < 0 {
            panic_with_error!(&env, Error::InvalidConfig);
        }
        env.storage().persistent().set(&DataKey::MarketMaxBet(market_id), &max_bet_amount);
    }

    pub fn set_council(env: Env, members: Vec<Address>, threshold: u32, timelock_secs: u64) {
        require_admin(&env);
        if threshold == 0 || threshold > members.len() {
            panic_with_error!(&env, Error::InvalidConfig);
        }
        env.storage()
            .instance()
            .set(&DataKey::Council, &Council { members, threshold, timelock_secs });
    }

    // ── Betting ──────────────────────────────────────────────────────────────

    /// Place a bet. Rejected if it would breach the global bet count, the
    /// global/per-market max bet amount, or the per-address exposure cap.
    pub fn place_bet(env: Env, bettor: Address, market_id: u64, is_yes: bool, amount: i128) {
        bettor.require_auth();
        if amount <= 0 {
            panic_with_error!(&env, Error::InvalidAmount);
        }
        let l = limits(&env);
        let store = env.storage().persistent();

        let max_bet: i128 = match store.get::<_, i128>(&DataKey::MarketMaxBet(market_id)) {
            Some(m) if m > 0 => m,
            _ => l.max_bet_amount,
        };
        if max_bet > 0 && amount > max_bet {
            panic_with_error!(&env, Error::BetAmountExceeded);
        }

        let count: u32 = store.get(&DataKey::UserBets(bettor.clone())).unwrap_or(0);
        if l.max_bets_per_user > 0 && count >= l.max_bets_per_user {
            panic_with_error!(&env, Error::BetCountExceeded);
        }

        let exposure: i128 = store.get(&DataKey::UserExposure(bettor.clone())).unwrap_or(0);
        if l.max_exposure_per_user > 0 && exposure + amount > l.max_exposure_per_user {
            panic_with_error!(&env, Error::ExposureExceeded);
        }

        let net = amount - amount * (l.fee_bps as i128) / 10_000;
        let (mut yes, mut no, bets): (i128, i128, u32) =
            store.get(&DataKey::MarketTotals(market_id)).unwrap_or((0, 0, 0));
        if is_yes {
            yes += net;
        } else {
            no += net;
        }

        store.set(&DataKey::UserBets(bettor.clone()), &(count + 1));
        store.set(&DataKey::UserExposure(bettor.clone()), &(exposure + amount));
        store.set(&DataKey::MarketTotals(market_id), &(yes, no, bets + 1));

        env.events().publish(
            (symbol_short!("bet"), symbol_short!("placed"), market_id),
            (bettor, is_yes, amount, net, env.ledger().timestamp()),
        );
    }

    pub fn user_bet_count(env: Env, bettor: Address) -> u32 {
        env.storage().persistent().get(&DataKey::UserBets(bettor)).unwrap_or(0)
    }

    pub fn user_exposure(env: Env, bettor: Address) -> i128 {
        env.storage().persistent().get(&DataKey::UserExposure(bettor)).unwrap_or(0)
    }

    // ── Council ──────────────────────────────────────────────────────────────

    /// Cast a council vote on a disputed market. Emits `("council","voted")` and,
    /// the first time an outcome reaches the threshold, `("council","threshold_reached")`.
    pub fn council_vote(env: Env, voter: Address, market_id: u64, outcome: u32) {
        voter.require_auth();
        let council: Council = env
            .storage()
            .instance()
            .get(&DataKey::Council)
            .unwrap_or_else(|| panic_with_error!(&env, Error::NotInitialized));
        if !council.members.contains(&voter) {
            panic_with_error!(&env, Error::NotCouncilMember);
        }
        let store = env.storage().persistent();
        let vote_key = DataKey::Vote(market_id, voter.clone());
        if store.has(&vote_key) {
            panic_with_error!(&env, Error::AlreadyVoted);
        }
        store.set(&vote_key, &outcome);

        let tally_key = DataKey::Tally(market_id, outcome);
        let votes: u32 = store.get(&tally_key).unwrap_or(0) + 1;
        store.set(&tally_key, &votes);

        env.events().publish(
            (symbol_short!("council"), symbol_short!("voted")),
            (market_id, voter, outcome, votes),
        );

        if votes >= council.threshold && !store.has(&DataKey::Resolved(market_id)) {
            store.set(&DataKey::Resolved(market_id), &outcome);
            let deadline = env.ledger().timestamp() + council.timelock_secs;
            env.events().publish(
                (symbol_short!("council"), Symbol::new(&env, "threshold_reached")),
                (market_id, outcome, deadline),
            );
        }
    }
}

#[cfg(test)]
mod test {
    use super::*;
    use soroban_sdk::{testutils::Address as _, vec};

    fn setup(l: Limits) -> (Env, MarketClient<'static>) {
        let env = Env::default();
        env.mock_all_auths();
        let c = MarketClient::new(&env, &env.register_contract(None, Market));
        c.initialize(&Address::generate(&env), &l);
        (env, c)
    }

    fn lim(bets: u32, bet: i128, exp: i128) -> Limits {
        Limits { max_bets_per_user: bets, max_bet_amount: bet, max_exposure_per_user: exp, fee_bps: 100 }
    }

    #[test]
    fn global_bet_count_spans_markets() {
        let (env, c) = setup(lim(2, 0, 0));
        let u = Address::generate(&env);
        c.place_bet(&u, &1, &true, &10);
        c.place_bet(&u, &2, &false, &10);
        assert!(c.try_place_bet(&u, &3, &true, &10).is_err());
        assert_eq!(c.user_bet_count(&u), 2);
    }

    #[test]
    fn exposure_and_amount_caps_reject() {
        let (env, c) = setup(lim(0, 50, 80));
        let u = Address::generate(&env);
        assert!(c.try_place_bet(&u, &1, &true, &51).is_err());
        c.place_bet(&u, &1, &true, &50);
        assert!(c.try_place_bet(&u, &2, &true, &31).is_err());
        assert_eq!(c.user_exposure(&u), 50);
    }

    #[test]
    fn per_market_override_applies() {
        let (env, c) = setup(lim(0, 100, 0));
        c.set_market_max_bet(&1, &10);
        let u = Address::generate(&env);
        assert!(c.try_place_bet(&u, &1, &true, &11).is_err());
        c.place_bet(&u, &2, &true, &11);
    }

    #[test]
    fn council_votes_are_restricted_and_single() {
        let (env, c) = setup(lim(0, 0, 0));
        let (a, b) = (Address::generate(&env), Address::generate(&env));
        c.set_council(&vec![&env, a.clone(), b.clone()], &2, &3600);
        c.council_vote(&a, &1, &0);
        c.council_vote(&b, &1, &0);
        assert!(c.try_council_vote(&a, &1, &0).is_err());
        assert!(c.try_council_vote(&Address::generate(&env), &1, &0).is_err());
    }
}
