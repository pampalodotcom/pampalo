// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title  DateMath
/// @notice Minimal UTC calendar-month math for the monthly cap accounting.
///         Uses Howard Hinnant's days-since-epoch algorithm (the standard
///         compact form). Cheaper and tighter in scope than pulling in a
///         full datetime library — we only need (year, month) from a
///         timestamp, never the day.
library DateMath {
  uint256 internal constant SECONDS_PER_DAY = 86400;

  /// @notice Returns `year * 12 + monthIndex` for the UTC calendar
  ///         month containing `timestamp`. `monthIndex` is in [0, 11]
  ///         (January = 0). Designed to be used as a bucket key, so the
  ///         absolute value doesn't matter — only that it changes
  ///         monotonically on each calendar-month boundary.
  function monthKey(uint256 timestamp) internal pure returns (uint64) {
    (uint256 year, uint256 month) = _yearMonth(timestamp);
    return uint64(year * 12 + (month - 1));
  }

  /// @notice Returns (year, month) for the UTC calendar date of
  ///         `timestamp`. `month` is in [1, 12]. Years before 1970 are
  ///         not supported (timestamps are non-negative).
  function _yearMonth(uint256 timestamp)
    internal
    pure
    returns (uint256 year, uint256 month)
  {
    // Days since 1970-01-01. Cast through int256 because the algorithm
    // shifts the epoch to 0000-03-01 (Hinnant's convention) and the
    // intermediate values are signed.
    int256 z = int256(timestamp / SECONDS_PER_DAY) + 719468;
    int256 era = (z >= 0 ? z : z - 146096) / 146097;
    uint256 doe = uint256(z - era * 146097);
    uint256 yoe =
      (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    uint256 y = yoe + uint256(era) * 400;
    uint256 doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    uint256 mp = (5 * doy + 2) / 153;
    uint256 m = mp < 10 ? mp + 3 : mp - 9;
    year = m <= 2 ? y + 1 : y;
    month = m;
  }
}
